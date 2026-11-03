import {
  CancelError,
  HttpError,
  InvalidRequestError,
  NetworkError,
  RequestError,
  TimeoutError,
} from '../errors.js'
import type { ClientResponse, PreparedRequest, RawResponse } from '../types.js'
import { createDeadline, delay } from './abort.js'
import { parseResponseBody } from './response.js'
import type { TransportRegistry } from '../transport/registry.js'

function normalizeError(error: unknown, request: PreparedRequest): RequestError {
  if (error instanceof RequestError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new NetworkError(`Transport failed: ${message}`, {
    cause: error,
    url: request.url,
    method: request.method,
  })
}

function isRetryable(request: PreparedRequest, error: RequestError, attempt: number): boolean {
  if (!request.retry.methods.includes(request.method)) return false
  if (request.retry.retryOn) return request.retry.retryOn(error, attempt)
  return (
    error instanceof TimeoutError ||
    error instanceof NetworkError ||
    (error instanceof HttpError && error.status >= 500)
  )
}

async function sendOnce(
  request: PreparedRequest,
  registry: TransportRegistry,
): Promise<ClientResponse> {
  if (request.signal?.aborted) {
    throw new CancelError('Request cancelled before it started', {
      cause: request.signal.reason,
      url: request.url,
      method: request.method,
    })
  }

  const deadline = createDeadline(request.timeout, request.signal)

  try {
    let url: URL
    try {
      url = new URL(request.url)
    } catch (cause) {
      throw new InvalidRequestError(`Invalid request URL: ${request.url}`, {
        cause,
        url: request.url,
        method: request.method,
      })
    }

    const transport = registry.resolve(url)
    const raw: RawResponse = await transport.send({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: deadline.signal,
      fetchOptions: request.fetchOptions,
    })

    if (raw.status < 200 || raw.status >= 300) {
      throw new HttpError(raw.status, {
        url: request.url,
        method: request.method,
        response: raw,
      })
    }

    const data = parseResponseBody(raw, request.responseType, {
      url: request.url,
      method: request.method,
    })

    return {
      status: raw.status,
      headers: raw.headers,
      data,
      raw,
    }
  } catch (rawError) {
    const error = normalizeError(rawError, request)

    if (deadline.timedOut()) {
      throw new TimeoutError(
        `Request timed out after ${request.timeout ?? 0}ms: ${request.method} ${request.url}`,
        { cause: error, url: request.url, method: request.method },
        request.timeout,
      )
    }

    if (request.signal?.aborted) {
      throw new CancelError('Request cancelled', {
        cause: error,
        url: request.url,
        method: request.method,
      })
    }

    throw error
  } finally {
    deadline.dispose()
  }
}

/** Execute a prepared request, including retries, timeout and decoding. */
export async function executeRequest(
  request: PreparedRequest,
  registry: TransportRegistry,
): Promise<ClientResponse> {
  let attempt = 0

  for (;;) {
    try {
      return await sendOnce(request, registry)
    } catch (rawError) {
      const error = normalizeError(rawError, request)

      if (request.signal?.aborted) {
        throw new CancelError('Request cancelled', {
          cause: error,
          url: request.url,
          method: request.method,
        })
      }

      if (attempt >= request.retry.count || !isRetryable(request, error, attempt)) {
        throw error
      }

      const wait = request.retry.delayMs * Math.pow(request.retry.factor, attempt)
      try {
        await delay(wait, request.signal)
      } catch {
        throw new CancelError('Request cancelled while waiting to retry', {
          cause: error,
          url: request.url,
          method: request.method,
        })
      }

      attempt += 1
    }
  }
}
