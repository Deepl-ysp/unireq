import { createClient } from './core/client.js'
import type { ClientResponse, RequestInput } from './types.js'

const defaultClient = createClient()

/**
 * Send a request with the shared default client.
 *
 * Accepts a URL string or a request options object. URL schemes select the
 * transport (`http:`, `https:` and Tauri 2.x `ipc:`).
 */
export function request<T = unknown>(input: RequestInput): Promise<ClientResponse<T>> {
  return defaultClient.request<T>(input)
}

export { createClient } from './core/client.js'
export {
  InvalidRequestError,
  CancelError,
  TimeoutError,
  NetworkError,
  HttpError,
  IpcError,
  TauriError,
  PolicyError,
  ParseError,
  RequestError,
} from './errors.js'
export type { ErrorCode, PolicyErrorReason, RequestErrorOptions } from './errors.js'
export {
  createPolicyMiddleware,
  evaluatePolicy,
  originOf,
  type PolicyDecision,
  type PolicyMode,
  type PolicyOptions,
  type PolicyRule,
} from './policy.js'
export {
  createTauriClient,
  DEFAULT_TAURI_TIMEOUT_MS,
  type TauriClient,
  type TauriClientOptions,
  type TauriInvokeOptions,
  type TauriIpcRequestOptions,
  type TauriListenOptions,
  type UnlistenFn,
} from './ipc/tauri-client.js'
export {
  buildTauriInvokeUrl,
  TauriTransport,
  type TauriTransportOptions,
} from './ipc/tauri-transport.js'
export {
  BrowserTauriBridge,
  NodeTauriBridge,
  createDefaultTauriBridge,
  installTauriKeyInterceptor,
  type BrowserTauriBridgeOptions,
  type NodeTauriBridgeOptions,
  type TauriBridge,
  type TauriBridgeRequest,
  type TauriBridgeResponse,
  type TauriPlatform,
} from './ipc/tauri-bridge.js'
export type {
  Client,
  ClientOptions,
  ClientResponse,
  FetchOptions,
  Headers,
  Middleware,
  PreparedRequest,
  QueryInput,
  QueryValue,
  RawResponse,
  RequestInput,
  RequestOptions,
  ResponseType,
  ResolvedRetry,
  RetryOptions,
  Transport,
  TransportRequest,
} from './types.js'
