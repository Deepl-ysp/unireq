import type { QueryInput, QueryPrimitive, QueryValue } from '../types.js'

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function isQueryArray(value: QueryValue): value is readonly QueryPrimitive[] {
  return Array.isArray(value)
}

function formatValue(value: string | number | boolean | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * Serialize query parameters.
 *
 * - `null` / `undefined` are skipped
 * - arrays become repeated keys (`tag=a&tag=b`)
 * - `Date` values become ISO strings
 */
export function serializeQuery(query: QueryInput | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (isQueryArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue
        params.append(key, formatValue(item))
      }
    } else {
      params.append(key, formatValue(value))
    }
  }
  return params.toString()
}

/** Resolve `baseUrl`, append query parameters, and keep the hash in place. */
export function buildUrl(url: string, baseUrl: string | undefined, query: QueryInput | undefined): string {
  let result = url
  if (baseUrl && !ABSOLUTE_URL.test(url)) {
    result = `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
  }

  const queryString = serializeQuery(query)
  if (!queryString) return result

  const hashIndex = result.indexOf('#')
  const hash = hashIndex >= 0 ? result.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? result.slice(0, hashIndex) : result
  const separator = withoutHash.includes('?') ? '&' : '?'
  return `${withoutHash}${separator}${queryString}${hash}`
}
