import { ParseError } from '../errors.js'
import type { RawResponse, ResponseType } from '../types.js'

interface ResponseMeta {
  url: string
  method: string
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes('application/json') || contentType.includes('+json')
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('application/xml') ||
    contentType.includes('+xml') ||
    contentType.includes('application/javascript') ||
    contentType.includes('application/x-www-form-urlencoded')
  )
}

function effectiveType(raw: RawResponse, responseType: ResponseType): Exclude<ResponseType, 'auto'> {
  if (responseType !== 'auto') return responseType
  const contentType = (raw.headers['content-type'] ?? '').toLowerCase()
  if (isJsonContentType(contentType)) return 'json'
  if (isTextContentType(contentType)) return 'text'
  return 'buffer'
}

/** Decode a raw body into JSON, text or bytes. */
export function parseResponseBody(
  raw: RawResponse,
  responseType: ResponseType,
  meta: ResponseMeta,
): unknown {
  const mode = effectiveType(raw, responseType)

  if (mode === 'buffer') return raw.body
  if (mode === 'arraybuffer') return new Uint8Array(raw.body).buffer

  const text = new TextDecoder().decode(raw.body)

  if (mode === 'text') return text

  if (raw.body.byteLength === 0) return null

  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new ParseError(`Failed to parse JSON response from ${meta.method} ${meta.url}`, {
      cause,
      url: meta.url,
      method: meta.method,
      response: raw,
    })
  }
}
