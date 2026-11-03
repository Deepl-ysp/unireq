import type { Headers } from '../types.js'

type HeaderInput = Record<string, string | string[] | undefined>

/** Lowercase header names and flatten array values (e.g. `set-cookie`). */
export function normalizeHeaders(input: HeaderInput | undefined): Headers {
  const output: Headers = {}
  if (!input) return output
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue
    output[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return output
}

/** Merge headers case-insensitively; later values win. */
export function mergeHeaders(base: Headers | undefined, extra: Record<string, string> | undefined): Headers {
  const output: Headers = { ...base }
  if (!extra) return output
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) continue
    output[name.toLowerCase()] = value
  }
  return output
}
