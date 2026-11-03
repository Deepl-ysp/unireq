import http from 'node:http'
import https from 'node:https'
import { NetworkError } from '../errors.js'
import { normalizeHeaders } from '../core/headers.js'
import type { RawResponse, Transport, TransportRequest } from '../types.js'

/**
 * Built-in HTTP(S) transport based on `node:http` / `node:https`.
 * Redirects are intentionally not followed; they surface as 3xx `HttpError`s.
 */
export class HttpTransport implements Transport {
  readonly name = 'http'

  supports(url: URL): boolean {
    return url.protocol === 'http:' || url.protocol === 'https:'
  }

  send(request: TransportRequest): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false
      let req: http.ClientRequest | undefined
      const chunks: Buffer[] = []

      const cleanup = (): void => {
        request.signal.removeEventListener('abort', onAbort)
      }

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      const succeed = (response: RawResponse): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(response)
      }

      const onAbort = (): void => {
        req?.destroy()
        fail(
          new NetworkError(`Request aborted while sending ${request.method} ${request.url}`, {
            cause: request.signal.reason,
            url: request.url,
            method: request.method,
          }),
        )
      }

      if (request.signal.aborted) {
        reject(
          new NetworkError('Request aborted before it was sent', {
            cause: request.signal.reason,
            url: request.url,
            method: request.method,
          }),
        )
        return
      }

      const target = new URL(request.url)
      const module = target.protocol === 'https:' ? https : http

      req = module.request(target, { method: request.method, headers: request.headers }, (res) => {
        res.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk))
        })
        res.on('aborted', () => {
          fail(
            new NetworkError(`Response aborted for ${request.method} ${request.url}`, {
              url: request.url,
              method: request.method,
            }),
          )
        })
        res.on('error', (cause) => {
          fail(
            new NetworkError(`HTTP response failed for ${request.method} ${request.url}`, {
              cause,
              url: request.url,
              method: request.method,
            }),
          )
        })
        res.on('end', () => {
          succeed({
            status: res.statusCode ?? 0,
            headers: normalizeHeaders(res.headers),
            body: Buffer.concat(chunks),
          })
        })
      })

      req.on('error', (cause) => {
        fail(
          new NetworkError(`HTTP request failed for ${request.method} ${request.url}`, {
            cause,
            url: request.url,
            method: request.method,
          }),
        )
      })

      request.signal.addEventListener('abort', onAbort, { once: true })
      req.end(request.body)
    })
  }
}
