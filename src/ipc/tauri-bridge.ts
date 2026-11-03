import { IpcError } from '../errors.js'
import type { FetchOptions } from '../types.js'

/** Windows uses the `ipc.localhost` HTTP(S) host; other platforms use `ipc://`. */
export type TauriPlatform = 'windows' | 'unix'

export interface TauriBridgeRequest {
  method: string
  headers: Record<string, string>
  body: string | Uint8Array | undefined
  signal: AbortSignal | undefined
  /** Pure fetch mechanics forwarded to the host `fetch`. */
  fetchOptions?: FetchOptions
}

export interface TauriBridgeResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

/**
 * Everything that depends on the host (webview) is isolated here. Inject a
 * fake implementation in Node tests; the transport and client never touch
 * `window` or `__TAURI_INTERNALS__` directly.
 */
export interface TauriBridge {
  readonly platform: TauriPlatform
  fetch(input: string, init: TauriBridgeRequest): Promise<TauriBridgeResponse>
  /** Resolve `Tauri-Invoke-Key`, probing the host if it was not captured yet. */
  getInvokeKey(): Promise<string | undefined>
  /** Drop the cached key so the next request re-captures it. */
  invalidateInvokeKey(): void
  /** Reuse Tauri's own callback registry (never build a parallel one). */
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number
  /** The host calls this to deliver callback payloads (events / channels). */
  runCallback(id: number, data: unknown): void
  postMessage?(message: unknown): void
}

interface TauriInternals {
  postMessage?: (message: unknown) => void
  transformCallback?: (callback: (payload: unknown) => void, once?: boolean) => number
  runCallback?: (id: number, data: unknown) => void
}

const INVOKE_KEY_HEADER = 'tauri-invoke-key'
const PROBE_DELAY_MS = 100

let cachedInvokeKey: string | undefined
let interceptorInstalled = false

function getInternals(): TauriInternals | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
}

function captureKey(name: string, value: string | null | undefined): void {
  if (typeof value === 'string' && value && name.toLowerCase() === INVOKE_KEY_HEADER) {
    cachedInvokeKey = value
  }
}

function inspectFetchHeaders(input: RequestInfo | URL, init: RequestInit | undefined): void {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    captureKey(INVOKE_KEY_HEADER, input.headers.get('Tauri-Invoke-Key'))
  }

  const headers = init?.headers
  if (!headers) return

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    captureKey(INVOKE_KEY_HEADER, headers.get('Tauri-Invoke-Key'))
    return
  }

  if (Array.isArray(headers)) {
    for (const [name, value] of headers) captureKey(name, value)
    return
  }

  for (const [name, value] of Object.entries(headers)) {
    captureKey(name, value)
  }
}

/**
 * Patch `Headers.prototype.set` and `window.fetch` as early as possible so the
 * host's own IPC requests reveal `Tauri-Invoke-Key`. Importing this module in a
 * browser installs the interceptor immediately; calling it again is a no-op.
 */
export function installTauriKeyInterceptor(): void {
  if (interceptorInstalled || typeof window === 'undefined') return
  interceptorInstalled = true

  const headersPrototype = window.Headers?.prototype
  if (headersPrototype?.set) {
    const originalSet = headersPrototype.set
    headersPrototype.set = function (this: Headers, name: string, value: string): void {
      captureKey(name, value)
      originalSet.call(this, name, value)
    }
  }

  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    const patchedFetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        inspectFetchHeaders(input, init)
      } catch {
        // The interceptor must never break the host's own requests.
      }
      return originalFetch.call(window, input, init)
    }
    window.fetch = patchedFetch as typeof window.fetch
  }
}

if (typeof window !== 'undefined') {
  installTauriKeyInterceptor()
}

function detectPlatform(): TauriPlatform {
  if (typeof navigator === 'undefined') return 'unix'
  return /Windows/i.test(navigator.userAgent) ? 'windows' : 'unix'
}

function toRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {}
  headers.forEach((value, name) => {
    output[name.toLowerCase()] = value
  })
  return output
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface BrowserTauriBridgeOptions {
  platform?: TauriPlatform
  /** Replace the webview fetch; useful in tests or non-standard hosts. */
  fetch?: typeof fetch
  keyProbeTimeoutMs?: number
}

/** Webview bridge: capture/probe the key and proxy Tauri's callback registry. */
export class BrowserTauriBridge implements TauriBridge {
  readonly platform: TauriPlatform
  private readonly fetchImpl: typeof fetch
  private readonly keyProbeTimeoutMs: number

  constructor(options: BrowserTauriBridgeOptions = {}) {
    installTauriKeyInterceptor()
    this.platform = options.platform ?? detectPlatform()
    this.fetchImpl = options.fetch ?? ((input, init) => window.fetch(input, init))
    this.keyProbeTimeoutMs = options.keyProbeTimeoutMs ?? PROBE_DELAY_MS
  }

  async fetch(input: string, init: TauriBridgeRequest): Promise<TauriBridgeResponse> {
    const response = await this.fetchImpl(input, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
      signal: init.signal,
      ...(init.fetchOptions ?? {}),
    })
    return {
      status: response.status,
      headers: toRecord(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    }
  }

  async getInvokeKey(): Promise<string | undefined> {
    if (cachedInvokeKey) return cachedInvokeKey
    return this.probeInvokeKey()
  }

  invalidateInvokeKey(): void {
    cachedInvokeKey = undefined
  }

  /**
   * Best-effort fallback when the key was not captured during page start-up.
   * A harmless `plugin:event|unlisten` invoke is posted; the host's own IPC
   * fetch is then picked up by the patched `Headers.prototype.set`/`fetch`.
   */
  async probeInvokeKey(): Promise<string | undefined> {
    if (cachedInvokeKey) return cachedInvokeKey
    const internals = getInternals()
    if (!internals?.postMessage) return undefined

    const id = randomUint32()
    try {
      internals.postMessage({
        cmd: 'invoke',
        callback: id,
        error: id,
        payload: {
          cmd: 'plugin:event|unlisten',
          args: { event: 'unireq-probe', eventId: 0 },
          options: undefined,
        },
      })
    } catch {
      return undefined
    }

    await sleep(this.keyProbeTimeoutMs)
    return cachedInvokeKey
  }

  transformCallback(callback: (payload: unknown) => void, once?: boolean): number {
    const internals = getInternals()
    if (!internals?.transformCallback) {
      throw new IpcError('Tauri transformCallback is unavailable; is this a Tauri webview?')
    }
    return internals.transformCallback(callback, once)
  }

  runCallback(id: number, data: unknown): void {
    const internals = getInternals()
    if (!internals?.runCallback) {
      throw new IpcError('Tauri runCallback is unavailable; is this a Tauri webview?')
    }
    internals.runCallback(id, data)
  }

  postMessage(message: unknown): void {
    getInternals()?.postMessage?.(message)
  }
}

export interface NodeTauriBridgeOptions {
  platform?: TauriPlatform
  fetch?: typeof fetch
  /** Node has no host bootstrap, so the key must be supplied explicitly. */
  keyProvider?: () => string | undefined | Promise<string | undefined>
}

/**
 * Node bridge: no Tauri host, no callback registry. It exists so the transport
 * can be exercised outside a webview and so applications can provide a key
 * manually (e.g. when driving a Tauri-like backend from tests).
 */
export class NodeTauriBridge implements TauriBridge {
  readonly platform: TauriPlatform
  private readonly fetchImpl: typeof fetch
  private readonly keyProvider: NodeTauriBridgeOptions['keyProvider']

  constructor(options: NodeTauriBridgeOptions = {}) {
    this.platform = options.platform ?? 'unix'
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.keyProvider = options.keyProvider
  }

  async fetch(input: string, init: TauriBridgeRequest): Promise<TauriBridgeResponse> {
    const response = await this.fetchImpl(input, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
      signal: init.signal,
      ...(init.fetchOptions ?? {}),
    })
    return {
      status: response.status,
      headers: toRecord(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    }
  }

  async getInvokeKey(): Promise<string | undefined> {
    return this.keyProvider?.()
  }

  invalidateInvokeKey(): void {
    // Nothing cached in Node; the provider is consulted again.
  }

  transformCallback(): number {
    throw new IpcError('Tauri event callbacks require a webview; inject a fake bridge in Node')
  }

  runCallback(): void {
    throw new IpcError('Tauri runCallback requires a webview; inject a fake bridge in Node')
  }
}

export interface DefaultTauriBridgeOptions extends NodeTauriBridgeOptions {
  keyProbeTimeoutMs?: number
}

/** Browser -> webview bridge, Node -> injectable-key bridge. */
export function createDefaultTauriBridge(options: DefaultTauriBridgeOptions = {}): TauriBridge {
  if (typeof window !== 'undefined') {
    return new BrowserTauriBridge(options)
  }
  return new NodeTauriBridge(options)
}

export function randomUint32(): number {
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.getRandomValues) {
    const values = new Uint32Array(1)
    cryptoObject.getRandomValues(values)
    return values[0] ?? 0
  }
  return Math.floor(Math.random() * 0x1_0000_0000)
}
