import { InvalidRequestError } from '../errors.js'
import type { Transport } from '../types.js'

/** Ordered transport registry. The most recently registered match wins, so a custom adapter can replace a built-in one. */
export class TransportRegistry {
  private readonly transports: Transport[] = []

  register(transport: Transport): this {
    if (this.transports.some((existing) => existing.name === transport.name)) {
      throw new InvalidRequestError(`A transport named "${transport.name}" is already registered`)
    }
    this.transports.push(transport)
    return this
  }

  resolve(url: URL): Transport {
    for (const transport of [...this.transports].reverse()) {
      if (transport.supports(url)) return transport
    }
    throw new InvalidRequestError(`No transport registered for scheme "${url.protocol}"`, {
      url: url.href,
    })
  }

  async close(): Promise<void> {
    for (const transport of this.transports) {
      await transport.close?.()
    }
  }
}
