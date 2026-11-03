import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export interface TestServer {
  baseUrl: string
  resetFlaky(): void
  flakyHits(): number
  close(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

async function handle(request: IncomingMessage, response: ServerResponse, flaky: { hits: number }): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  switch (url.pathname) {
    case '/echo': {
      const body = await readBody(request)
      sendJson(response, 200, {
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: request.headers,
        body: body.toString('utf8'),
      })
      return
    }

    case '/flaky': {
      flaky.hits += 1
      if (flaky.hits < 3) {
        sendJson(response, 503, { error: 'temporary', hit: flaky.hits })
      } else {
        sendJson(response, 200, { hit: flaky.hits })
      }
      return
    }

    case '/slow': {
      const ms = Number(url.searchParams.get('ms') ?? '300')
      await sleep(ms)
      if (!response.destroyed) sendJson(response, 200, { waited: ms })
      return
    }

    case '/bad-json': {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end('{not json')
      return
    }

    case '/text': {
      response.statusCode = 200
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end('hello unireq')
      return
    }

    case '/binary': {
      response.statusCode = 200
      response.setHeader('content-type', 'application/octet-stream')
      response.end(Buffer.from([0, 1, 2, 255]))
      return
    }

    case '/empty-json': {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end()
      return
    }

    default: {
      sendJson(response, 404, { error: 'not found', path: url.pathname })
    }
  }
}

export async function startTestServer(): Promise<TestServer> {
  const flaky = { hits: 0 }
  const sockets = new Set<Socket>()

  const server = createServer((request, response) => {
    void handle(request, response, flaky).catch((error: unknown) => {
      if (!response.headersSent) {
        response.statusCode = 500
        response.setHeader('content-type', 'text/plain')
      }
      response.end(String(error))
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    resetFlaky: () => {
      flaky.hits = 0
    },
    flakyHits: () => flaky.hits,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
