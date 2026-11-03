import { HttpTransport } from '../http/http-transport.js'
import { createDefaultTauriBridge } from '../ipc/tauri-bridge.js'
import { TauriTransport } from '../ipc/tauri-transport.js'
import { createPolicyMiddleware } from '../policy.js'
import { TransportRegistry } from '../transport/registry.js'
import type {
  Client,
  ClientOptions,
  ClientResponse,
  Middleware,
  PreparedRequest,
  RequestInput,
} from '../types.js'
import { normalizeHeaders } from './headers.js'
import { executeRequest } from './execute.js'
import { prepareRequest, resolveRetry, type ClientDefaults } from './prepare.js'

/**
 * Create an isolated client with its own defaults, middleware stack and
 * transport registry. Use this in applications and tests.
 */
export function createClient(options: ClientOptions = {}): Client {
  const registry = new TransportRegistry()
  if (options.builtins !== false) {
    registry
      .register(new HttpTransport())
      .register(new TauriTransport({ bridge: createDefaultTauriBridge() }))
  }
  for (const transport of options.transports ?? []) {
    registry.register(transport)
  }

  const defaults: ClientDefaults = {
    baseUrl: options.baseUrl,
    headers: normalizeHeaders(options.headers),
    timeout: options.timeout,
    responseType: options.responseType ?? 'auto',
    retry: resolveRetry(options.retry),
    fetchOptions: options.fetchOptions ?? {},
  }

  // The policy runs before caller middleware so later hooks cannot bypass it.
  const middlewares: Middleware[] = options.policy
    ? [createPolicyMiddleware(options.policy)]
    : []

  const client: Client = {
    async request<T = unknown>(input: RequestInput): Promise<ClientResponse<T>> {
      const prepared: PreparedRequest = prepareRequest(input, defaults)

      const dispatch = (index: number): Promise<ClientResponse> => {
        const middleware = middlewares[index]
        if (!middleware) return executeRequest(prepared, registry)
        return middleware(prepared, () => dispatch(index + 1))
      }

      return (await dispatch(0)) as ClientResponse<T>
    },

    use(middleware: Middleware): Client {
      middlewares.push(middleware)
      return client
    },

    registerTransport(transport): Client {
      registry.register(transport)
      return client
    },

    async close(): Promise<void> {
      await registry.close()
    },
  }

  return client
}
