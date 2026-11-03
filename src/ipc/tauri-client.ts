import { createClient } from '../core/client.js'
import { InvalidRequestError, TauriError } from '../errors.js'
import type { PolicyOptions } from '../policy.js'
import type {
  Client,
  ClientResponse,
  FetchOptions,
  Middleware,
  RequestInput,
  ResponseType,
  RetryOptions,
} from '../types.js'
import {
  createDefaultTauriBridge,
  type DefaultTauriBridgeOptions,
  type TauriBridge,
} from './tauri-bridge.js'
import { buildTauriInvokeUrl, TauriTransport } from './tauri-transport.js'

/** High-level Tauri calls must never hang forever on a bad invoke key. */
export const DEFAULT_TAURI_TIMEOUT_MS = 15_000

const URL_LIKE = /^(?:ipc|http|https):\/\//i

export interface TauriClientOptions extends DefaultTauriBridgeOptions {
  /** Inject a fake/alternative bridge (Node tests, custom hosts). */
  bridge?: TauriBridge
  /** Windows only: use `https://ipc.localhost`. */
  useHttpsScheme?: boolean
  /** Default timeout for every Tauri request. Defaults to 15s. */
  timeout?: number
  headers?: Record<string, string>
  /** Default pure fetch mechanics for host requests. */
  fetchOptions?: FetchOptions
  /** Unified allow/deny policy; runs before user middleware. */
  policy?: PolicyOptions
  /** Initial middleware stack; use it for allow/deny or request interception. */
  middlewares?: readonly Middleware[]
}

export interface TauriInvokeOptions {
  headers?: Record<string, string>
  timeout?: number
  signal?: AbortSignal
  responseType?: ResponseType
  retry?: number | RetryOptions
  /** Pure fetch mechanics (mode/credentials/redirect/referrerPolicy). */
  fetchOptions?: FetchOptions
  /** Opaque caller context, preserved on `PolicyError`. */
  context?: unknown
}

/** Low-level request: the caller receives headers and bytes without JSON coercion. */
export interface TauriIpcRequestOptions extends TauriInvokeOptions {
  body?: unknown
}

export interface TauriListenOptions {
  /** Tauri event target. Defaults to `{ kind: 'Any' }`. */
  target?: unknown
}

export type UnlistenFn = () => Promise<void>

export interface TauriClient {
  /** Command name (or a full `ipc://` URL); JSON in, JSON out. */
  invoke<T = unknown>(command: string, args?: unknown, options?: TauriInvokeOptions): Promise<T>
  /** High-level invoke that keeps the full response and defaults to raw bytes. */
  invokeRaw<T = Uint8Array>(
    command: string,
    args?: unknown,
    options?: TauriInvokeOptions,
  ): Promise<ClientResponse<T>>
  /** Low-level IPC request; `Tauri-Response` stays visible for the caller. */
  ipcRequest<T = unknown>(
    command: string,
    options?: TauriIpcRequestOptions,
  ): Promise<ClientResponse<T>>
  listen<T = unknown>(
    event: string,
    handler: (payload: T) => void,
    options?: TauriListenOptions,
  ): Promise<UnlistenFn>
  /** Escape hatch to the underlying client, including custom `ipc://` URLs. */
  request<T = unknown>(input: RequestInput): Promise<ClientResponse<T>>
  use(middleware: Middleware): TauriClient
  close(): Promise<void>
}

function resolveCommandUrl(
  command: string,
  platform: TauriBridge['platform'],
  useHttpsScheme: boolean,
): string {
  const trimmed = command?.trim()
  if (!trimmed) throw new InvalidRequestError('A Tauri command name is required')
  if (URL_LIKE.test(trimmed)) return trimmed
  return buildTauriInvokeUrl(command, platform, useHttpsScheme)
}

interface TauriErrorShape {
  message?: unknown
  error?: unknown
  code?: unknown
}

function errorMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string' && payload) return payload
  if (payload !== null && typeof payload === 'object') {
    const shaped = payload as TauriErrorShape
    if (typeof shaped.message === 'string' && shaped.message) return shaped.message
    if (typeof shaped.error === 'string' && shaped.error) return shaped.error
  }
  return undefined
}

function assertTauriSuccess<T>(
  response: ClientResponse<T>,
  command: string,
  url: string,
): ClientResponse<T> {
  const header = (response.headers['tauri-response'] ?? '').toLowerCase()
  if (header !== 'error') return response

  const message = errorMessage(response.data) ?? `Tauri command "${command}" failed`
  throw new TauriError(message, {
    command,
    payload: response.data,
    url,
    method: 'POST',
    response: response.raw,
  })
}

/**
 * Create a Tauri 2.x client. `invoke` is the one-liner; `ipcRequest` keeps raw
 * bytes and all response headers for resource-oriented commands.
 */
export function createTauriClient(options: TauriClientOptions = {}): TauriClient {
  const bridge = options.bridge ?? createDefaultTauriBridge(options)
  const useHttpsScheme = options.useHttpsScheme ?? false
  const transport = new TauriTransport({ bridge, useHttpsScheme })

  const client: Client = createClient({
    builtins: false,
    timeout: options.timeout ?? DEFAULT_TAURI_TIMEOUT_MS,
    headers: options.headers,
    fetchOptions: options.fetchOptions,
    policy: options.policy,
    transports: [transport],
  })

  for (const middleware of options.middlewares ?? []) {
    client.use(middleware)
  }

  const send = <T = unknown>(
    command: string,
    requestBody: unknown,
    requestOptions: TauriInvokeOptions,
    responseType: ResponseType,
  ): Promise<ClientResponse<T>> => {
    const url = resolveCommandUrl(command, bridge.platform, useHttpsScheme)
    return client.request<T>({
      url,
      method: 'POST',
      headers: requestOptions.headers,
      body: requestBody,
      timeout: requestOptions.timeout,
      signal: requestOptions.signal,
      responseType: requestOptions.responseType ?? responseType,
      retry: requestOptions.retry,
      fetchOptions: requestOptions.fetchOptions,
      context: requestOptions.context,
    })
  }

  const tauri: TauriClient = {
    async invoke<T = unknown>(
      command: string,
      args?: unknown,
      invokeOptions: TauriInvokeOptions = {},
    ): Promise<T> {
      const url = resolveCommandUrl(command, bridge.platform, useHttpsScheme)
      const response = await send(command, args, invokeOptions, 'json')
      assertTauriSuccess(response, command, url)
      return response.data as T
    },

    async invokeRaw<T = Uint8Array>(
      command: string,
      args?: unknown,
      invokeOptions: TauriInvokeOptions = {},
    ): Promise<ClientResponse<T>> {
      const url = resolveCommandUrl(command, bridge.platform, useHttpsScheme)
      const response = await send<T>(command, args, invokeOptions, 'buffer')
      return assertTauriSuccess(response, command, url)
    },

    ipcRequest<T = unknown>(
      command: string,
      ipcOptions: TauriIpcRequestOptions = {},
    ): Promise<ClientResponse<T>> {
      return send<T>(command, ipcOptions.body, ipcOptions, 'auto')
    },

    async listen<T = unknown>(
      event: string,
      handler: (payload: T) => void,
      listenOptions: TauriListenOptions = {},
    ): Promise<UnlistenFn> {
      const target = listenOptions.target ?? { kind: 'Any' }
      const handlerId = bridge.transformCallback((payload) => handler(payload as T))
      const eventId = await tauri.invoke<number>('plugin:event|listen', {
        event,
        target,
        handler: handlerId,
      })

      return async () => {
        await tauri.invoke('plugin:event|unlisten', { event, eventId, target })
      }
    },

    request<T = unknown>(input: RequestInput): Promise<ClientResponse<T>> {
      return client.request<T>(input)
    },

    use(middleware: Middleware): TauriClient {
      client.use(middleware)
      return tauri
    },

    close(): Promise<void> {
      return client.close()
    },
  }

  return tauri
}
