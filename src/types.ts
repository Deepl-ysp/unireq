import type { RequestError } from './errors.js'
import type { PolicyOptions } from './policy.js'

export type { PolicyOptions } from './policy.js'

/** Header map. Names are normalized to lowercase by the core before reaching a transport. */
export type Headers = Record<string, string>

/**
 * How a response body should be decoded. `auto` uses the content-type;
 * `buffer` yields a `Uint8Array` (a `Buffer` in Node); `arraybuffer` yields an
 * `ArrayBuffer`.
 */
export type ResponseType = 'auto' | 'json' | 'text' | 'buffer' | 'arraybuffer'

export type QueryPrimitive = string | number | boolean | Date | null | undefined
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[]
export type QueryInput = Record<string, QueryValue>

/**
 * Pure technical knobs forwarded to `fetch`. This is **not** a policy hook:
 * mode/credentials only control browser mechanics, while allow/deny decisions
 * belong to `PolicyOptions`.
 */
export interface FetchOptions {
  mode?: RequestMode
  credentials?: RequestCredentials
  redirect?: RequestRedirect
  referrerPolicy?: ReferrerPolicy
}

export interface RetryOptions {
  /** Number of retries **after** the first attempt. `0` disables retries. */
  count: number
  /** Base delay in milliseconds. Defaults to `100`. */
  delayMs?: number
  /** Exponential backoff factor. Defaults to `2`. */
  factor?: number
  /** HTTP methods eligible for retries. Defaults to idempotent methods. */
  methods?: readonly string[]
  /**
   * Decide whether an error is retryable. Receives the normalized error and
   * the zero-based attempt that just failed.
   */
  retryOn?: (error: RequestError, attempt: number) => boolean
}

export interface RequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  query?: QueryInput
  /** Plain objects are JSON-encoded; strings and Uint8Array are sent as-is. */
  body?: unknown
  /** Per-attempt timeout in milliseconds. `0` disables the timeout. */
  timeout?: number
  signal?: AbortSignal
  responseType?: ResponseType
  /** `number` is shorthand for `{ count }`. */
  retry?: number | RetryOptions
  /** Pure `fetch` mechanics (mode/credentials/redirect/referrerPolicy). */
  fetchOptions?: FetchOptions
  /** Opaque caller context, preserved verbatim on `PolicyError`. */
  context?: unknown
}

export type RequestInput = string | RequestOptions

/** A request after defaults, URL building and header normalization. */
export interface PreparedRequest {
  url: string
  method: string
  headers: Headers
  body: string | Uint8Array | undefined
  timeout: number | undefined
  signal: AbortSignal | undefined
  responseType: ResponseType
  retry: ResolvedRetry
  fetchOptions: FetchOptions
  context: unknown
}

export interface ResolvedRetry {
  count: number
  delayMs: number
  factor: number
  methods: readonly string[]
  retryOn: ((error: RequestError, attempt: number) => boolean) | undefined
}

export interface TransportRequest {
  /** Fully built URL, including query parameters and without the hash. */
  url: string
  method: string
  headers: Headers
  body: string | Uint8Array | undefined
  /** Aborted when the caller's signal aborts or a timeout fires. */
  signal: AbortSignal
  /** Technical fetch options; transports that do not use `fetch` may ignore them. */
  fetchOptions?: FetchOptions
}

/** Transport-level response. This is what an adapter must produce. */
export interface RawResponse {
  status: number
  headers: Headers
  body: Uint8Array
}

/**
 * A pluggable transport. Implementations only map a URL to a protocol and
 * exchange `TransportRequest` / `RawResponse` objects; defaults, retries,
 * timeouts, middleware and body decoding live in the core.
 */
export interface Transport {
  readonly name: string
  supports(url: URL): boolean
  send(request: TransportRequest): Promise<RawResponse>
  /** Optional cleanup hook used by `Client.close()`. */
  close?(): void | Promise<void>
}

/** The unified response exposed to callers. */
export interface ClientResponse<T = unknown> {
  status: number
  headers: Headers
  data: T
  /** Untouched transport response, including the undecoded body. */
  raw: RawResponse
}

export type Middleware = (
  request: PreparedRequest,
  next: () => Promise<ClientResponse>,
) => Promise<ClientResponse>

export interface ClientOptions {
  baseUrl?: string
  headers?: Record<string, string>
  timeout?: number
  responseType?: ResponseType
  retry?: number | RetryOptions
  fetchOptions?: FetchOptions
  /** Unified allow/deny policy; runs as the first middleware. */
  policy?: PolicyOptions
  /** Extra transports, registered after the built-in ones. */
  transports?: readonly Transport[]
  /** Set `false` to skip the built-in HTTP/Tauri transports. Defaults to `true`. */
  builtins?: boolean
}

export interface Client {
  request<T = unknown>(input: RequestInput): Promise<ClientResponse<T>>
  use(middleware: Middleware): Client
  registerTransport(transport: Transport): Client
  close(): Promise<void>
}
