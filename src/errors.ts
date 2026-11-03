import type { RawResponse } from './types.js'

export type ErrorCode =
  | 'EINVALID'
  | 'ECANCEL'
  | 'ETIMEOUT'
  | 'ENETWORK'
  | 'EHTTP'
  | 'EIPC'
  | 'ETAURI'
  | 'EPOLICY'
  | 'EPARSE'

export interface RequestErrorOptions {
  cause?: unknown
  url?: string
  method?: string
  /** Raw transport response, when one exists. */
  response?: RawResponse
}

/**
 * Base class for every error produced by the library. Branch on `code` for
 * portable checks, or on the subclass for richer typing.
 */
export class RequestError extends Error {
  readonly code: ErrorCode
  readonly url: string | undefined
  readonly method: string | undefined
  readonly response: RawResponse | undefined

  constructor(message: string, code: ErrorCode, options: RequestErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RequestError'
    this.code = code
    this.url = options.url
    this.method = options.method
    this.response = options.response
  }
}

/** The input could not be turned into a request, or no transport matches. */
export class InvalidRequestError extends RequestError {
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, 'EINVALID', options)
    this.name = 'InvalidRequestError'
  }
}

/** The request was cancelled through an `AbortSignal`. */
export class CancelError extends RequestError {
  constructor(message = 'Request cancelled', options: RequestErrorOptions = {}) {
    super(message, 'ECANCEL', options)
    this.name = 'CancelError'
  }
}

/** A per-attempt timeout fired. */
export class TimeoutError extends RequestError {
  readonly timeoutMs: number | undefined

  constructor(message: string, options: RequestErrorOptions = {}, timeoutMs?: number) {
    super(message, 'ETIMEOUT', options)
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Connection refused, socket reset, DNS failure, or any transport crash. */
export class NetworkError extends RequestError {
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, 'ENETWORK', options)
    this.name = 'NetworkError'
  }
}

/** The server answered with a status outside 2xx. */
export class HttpError extends RequestError {
  readonly status: number

  constructor(status: number, options: RequestErrorOptions = {}) {
    const target = options.method && options.url ? `${options.method} ${options.url}` : options.url
    super(`HTTP ${status}${target ? ` for ${target}` : ''}`, 'EHTTP', options)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Errors coming from the IPC transport itself (not an application status). */
export class IpcError extends RequestError {
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, 'EIPC', options)
    this.name = 'IpcError'
  }
}

/**
 * A Tauri command returned `Tauri-Response: error`. The HTTP status is still
 * 200; `payload` holds the decoded error body from the Rust side.
 */
export class TauriError extends RequestError {
  readonly command: string
  readonly payload: unknown

  constructor(
    message: string,
    options: RequestErrorOptions & { command?: string; payload?: unknown } = {},
  ) {
    super(message, 'ETAURI', options)
    this.name = 'TauriError'
    this.command = options.command ?? ''
    this.payload = options.payload
  }
}

export type PolicyErrorReason = 'denied' | 'denied-scheme' | 'not-allowlisted'

/**
 * A request was rejected by the unified policy. `context` is whatever the
 * caller attached to the request (for example an import chain) and is kept
 * as-is for upper layers to build their own message.
 */
export class PolicyError extends RequestError {
  readonly reason: PolicyErrorReason
  readonly origin: string
  readonly context: unknown

  constructor(
    reason: PolicyErrorReason,
    options: RequestErrorOptions & { origin?: string; context?: unknown } = {},
  ) {
    const target = options.method && options.url ? `: ${options.method} ${options.url}` : ''
    super(`Request blocked by policy (${reason})${target}`, 'EPOLICY', options)
    this.name = 'PolicyError'
    this.reason = reason
    this.origin = options.origin ?? ''
    this.context = options.context
  }
}

/** A body advertised as JSON could not be parsed, or decoding failed. */
export class ParseError extends RequestError {
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, 'EPARSE', options)
    this.name = 'ParseError'
  }
}
