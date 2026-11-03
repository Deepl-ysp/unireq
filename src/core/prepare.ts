import { InvalidRequestError } from '../errors.js'
import type {
  FetchOptions,
  Headers,
  PreparedRequest,
  RequestInput,
  RequestOptions,
  ResponseType,
  ResolvedRetry,
  RetryOptions,
} from '../types.js'
import { normalizeHeaders } from './headers.js'
import { buildUrl } from './url.js'

const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'] as const

export interface ClientDefaults {
  baseUrl: string | undefined
  headers: Headers
  timeout: number | undefined
  responseType: ResponseType
  retry: ResolvedRetry
  fetchOptions: FetchOptions
}

export function resolveRetry(retry: number | RetryOptions | undefined): ResolvedRetry {
  if (retry === undefined) {
    return { count: 0, delayMs: 100, factor: 2, methods: IDEMPOTENT_METHODS, retryOn: undefined }
  }
  if (typeof retry === 'number') {
    return {
      count: Math.max(0, retry),
      delayMs: 100,
      factor: 2,
      methods: IDEMPOTENT_METHODS,
      retryOn: undefined,
    }
  }
  return {
    count: Math.max(0, retry.count),
    delayMs: retry.delayMs ?? 100,
    factor: retry.factor ?? 2,
    methods: retry.methods ?? IDEMPOTENT_METHODS,
    retryOn: retry.retryOn,
  }
}

export function normalizeBody(body: unknown, headers: Headers): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array) return body
  if (headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
  }
  const json = JSON.stringify(body)
  return json ?? String(body)
}

function toOptions(input: RequestInput): RequestOptions {
  return typeof input === 'string' ? { url: input } : input
}

export function prepareRequest(input: RequestInput, defaults: ClientDefaults): PreparedRequest {
  const options = toOptions(input)
  const trimmedUrl = options.url?.trim()
  if (!trimmedUrl) {
    throw new InvalidRequestError('A request URL is required')
  }

  const url = buildUrl(trimmedUrl, defaults.baseUrl, options.query)
  const method = (options.method ?? 'GET').trim().toUpperCase()
  if (!method) {
    throw new InvalidRequestError('A request method is required', { url })
  }

  const headers = normalizeHeaders({ ...defaults.headers, ...options.headers })
  const body = normalizeBody(options.body, headers)

  return {
    url,
    method,
    headers,
    body,
    timeout: options.timeout ?? defaults.timeout,
    signal: options.signal,
    responseType: options.responseType ?? defaults.responseType,
    retry: resolveRetry(options.retry ?? defaults.retry),
    fetchOptions: { ...defaults.fetchOptions, ...options.fetchOptions },
    context: options.context,
  }
}
