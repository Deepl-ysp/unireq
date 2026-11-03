import { InvalidRequestError, IpcError } from '../errors.js'
import { normalizeHeaders } from '../core/headers.js'
import type { RawResponse, Transport, TransportRequest } from '../types.js'
import { randomUint32, type TauriBridge, type TauriPlatform } from './tauri-bridge.js'

export interface TauriTransportOptions {
  bridge: TauriBridge
  /** Windows only: use `https://ipc.localhost` instead of `http://`. */
  useHttpsScheme?: boolean
}

/** Build the wire URL for a command, percent-encoding the command segment. */
export function buildTauriInvokeUrl(
  command: string,
  platform: TauriPlatform,
  useHttpsScheme = false,
): string {
  const encoded = encodeURIComponent(command)
  if (platform === 'windows') {
    return `${useHttpsScheme ? 'https' : 'http'}://ipc.localhost/${encoded}`
  }
  return `ipc://localhost/${encoded}`
}

/**
 * Tauri 2.x IPC transport.
 *
 * - Windows: `http(s)://ipc.localhost/<cmd>`
 * - macOS / Linux: `ipc://localhost/<cmd>`
 *
 * Both forms are accepted. `Tauri-Response: error` is **not** converted into an
 * exception here: the raw response (including that header) is returned so the
 * low-level API can let callers decide. The high-level client maps it.
 */
export class TauriTransport implements Transport {
  readonly name = 'tauri-ipc'
  private readonly bridge: TauriBridge
  private readonly useHttpsScheme: boolean

  constructor(options: TauriTransportOptions) {
    this.bridge = options.bridge
    this.useHttpsScheme = options.useHttpsScheme ?? false
  }

  supports(url: URL): boolean {
    if (url.protocol === 'ipc:') return true
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.toLowerCase() === 'ipc.localhost'
    )
  }

  async send(request: TransportRequest): Promise<RawResponse> {
    const method = request.method.toUpperCase()
    // `request('ipc://...')` defaults to GET; a bodyless GET is treated as the
    // canonical POST invoke so the low-level string form is directly usable.
    if (method !== 'POST' && !(method === 'GET' && request.body === undefined)) {
      throw new InvalidRequestError('Tauri IPC requests must use POST', {
        url: request.url,
        method: request.method,
      })
    }

    const target = this.resolveUrl(request.url)
    const command = this.readCommand(target)
    const body = request.body ?? '{}'
    const binary = body instanceof Uint8Array

    const baseHeaders: Record<string, string> = {
      ...request.headers,
      'content-type': binary ? 'application/octet-stream' : 'application/json',
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const key = await this.bridge.getInvokeKey()
      if (!key) {
        throw new IpcError(
          'Tauri invoke key is unavailable; start the key interceptor before the webview boots or supply a key provider',
          { url: request.url, method: request.method },
        )
      }

      let response
      try {
        response = await this.bridge.fetch(target.href, {
          method: 'POST',
          headers: {
            ...baseHeaders,
            'tauri-callback': String(randomUint32()),
            'tauri-error': String(randomUint32()),
            'tauri-invoke-key': key,
          },
          body,
          signal: request.signal,
          fetchOptions: request.fetchOptions,
        })
      } catch (cause) {
        throw new IpcError(`Tauri IPC request failed for "${command}"`, {
          cause,
          url: request.url,
          method: request.method,
        })
      }

      // A stale key is rejected before the command runs. Refresh once.
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        this.bridge.invalidateInvokeKey()
        continue
      }

      return {
        status: response.status,
        headers: normalizeHeaders(response.headers),
        body: response.body,
      }
    }

    throw new IpcError(`Tauri IPC request for "${command}" exhausted key refreshes`, {
      url: request.url,
      method: request.method,
    })
  }

  private resolveUrl(requestUrl: string): URL {
    let url: URL
    try {
      url = new URL(requestUrl)
    } catch (cause) {
      throw new InvalidRequestError(`Invalid Tauri IPC URL: ${requestUrl}`, {
        cause,
        url: requestUrl,
      })
    }

    if (url.protocol === 'ipc:' && this.bridge.platform === 'windows') {
      const scheme = this.useHttpsScheme ? 'https' : 'http'
      return new URL(`${scheme}://ipc.localhost${url.pathname}`)
    }

    return url
  }

  private readCommand(url: URL): string {
    const raw = url.pathname.replace(/^\/+/, '')
    if (!raw) {
      throw new InvalidRequestError('A Tauri command name is required', { url: url.href })
    }
    try {
      return decodeURIComponent(raw)
    } catch (cause) {
      throw new InvalidRequestError(`Invalid Tauri command encoding: ${raw}`, {
        cause,
        url: url.href,
      })
    }
  }
}
