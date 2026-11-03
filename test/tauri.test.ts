import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import {
  IpcError,
  TauriError,
  TimeoutError,
  createTauriClient,
  type TauriBridge,
  type TauriBridgeRequest,
  type TauriBridgeResponse,
  type TauriPlatform,
} from '../src/index.js'

interface Recorded {
  command: string
  method: string
  headers: Record<string, string>
  body: string
}

function lowerHeaders(input: IncomingHttpHeaders): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue
    output[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return output
}

function readBody(headers: Record<string, string>, body: Buffer): string {
  if (headers['content-type'] === 'application/octet-stream') return body.toString('hex')
  return body.toString('utf8')
}

let recorded: Recorded[] = []
let baseUrl = ''

function lastRecorded(command: string): Recorded {
  const matches = recorded.filter((entry) => entry.command === command)
  const last = matches[matches.length - 1]
  assert.ok(last, `no recorded request for ${command}`)
  return last
}

function jsonResponse(
  response: import('node:http').ServerResponse,
  payload: unknown,
  tauriResponse: 'ok' | 'error' = 'ok',
): void {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  response.setHeader('Tauri-Response', tauriResponse)
  response.end(JSON.stringify(payload))
}

const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
    const body = Buffer.concat(chunks)
    const pathname = new URL(request.url ?? '/', 'http://ipc.localhost').pathname
    let command = ''
    try {
      command = decodeURIComponent(pathname.replace(/^\/+/, ''))
    } catch {
      command = pathname
    }

    const headers = lowerHeaders(request.headers)
    recorded.push({
      command,
      method: request.method ?? '',
      headers,
      body: readBody(headers, body),
    })

    switch (command) {
      case 'demo:echo': {
        jsonResponse(response, { ok: true })
        return
      }
      case 'demo:fail': {
        jsonResponse(response, { code: 'BOOM', message: 'boom' }, 'error')
        return
      }
      case 'demo:binary': {
        response.statusCode = 200
        response.setHeader('content-type', 'application/octet-stream')
        response.setHeader('Tauri-Response', 'ok')
        response.end(Buffer.from([0, 1, 2, 255]))
        return
      }
      case 'demo:slow': {
        setTimeout(() => {
          if (!response.destroyed) jsonResponse(response, { waited: true })
        }, 150)
        return
      }
      case 'demo:key': {
        if (headers['tauri-invoke-key'] !== 'fresh') {
          response.statusCode = 403
          response.end()
          return
        }
        jsonResponse(response, { key: headers['tauri-invoke-key'] })
        return
      }
      case 'plugin:event|listen': {
        jsonResponse(response, 7)
        return
      }
      case 'plugin:event|unlisten': {
        jsonResponse(response, null)
        return
      }
      default: {
        response.statusCode = 404
        response.end()
      }
    }
  })().catch((error: unknown) => {
    response.statusCode = 500
    response.end(String(error))
  })
})

class FakeBridge implements TauriBridge {
  readonly requests: Array<{ url: string; init: TauriBridgeRequest }> = []
  readonly callbacks = new Map<number, (payload: unknown) => void>()
  private nextCallbackId = 100
  private keyIndex = 0

  constructor(
    readonly platform: TauriPlatform,
    private readonly keys: ReadonlyArray<string | undefined>,
  ) {}

  async fetch(input: string, init: TauriBridgeRequest): Promise<TauriBridgeResponse> {
    this.requests.push({ url: input, init: { ...init, headers: { ...init.headers } } })

    const target = input
      .replace(/^ipc:\/\/localhost/, baseUrl)
      .replace(/^https?:\/\/ipc\.localhost/, baseUrl)

    const response = await fetch(target, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
      signal: init.signal,
    })

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value
    })

    return {
      status: response.status,
      headers: responseHeaders,
      body: new Uint8Array(await response.arrayBuffer()),
    }
  }

  async getInvokeKey(): Promise<string | undefined> {
    return this.keys[Math.min(this.keyIndex, this.keys.length - 1)]
  }

  invalidateInvokeKey(): void {
    this.keyIndex = Math.min(this.keyIndex + 1, Math.max(this.keys.length - 1, 0))
  }

  transformCallback(callback: (payload: unknown) => void): number {
    const id = this.nextCallbackId
    this.nextCallbackId += 1
    this.callbacks.set(id, callback)
    return id
  }

  runCallback(id: number, data: unknown): void {
    this.callbacks.get(id)?.(data)
  }
}

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('invoke builds the Windows Tauri envelope and percent-encodes the command', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['key-1'])
  const tauri = createTauriClient({ bridge })

  const data = await tauri.invoke<{ ok: boolean }>('demo:echo', { a: 1, b: 'x' })

  assert.deepEqual(data, { ok: true })
  const sent = bridge.requests.at(-1)
  assert.ok(sent)
  assert.equal(sent.url, 'http://ipc.localhost/demo%3Aecho')
  assert.equal(sent.init.method, 'POST')
  assert.equal(sent.init.headers['content-type'], 'application/json')
  assert.equal(sent.init.headers['tauri-invoke-key'], 'key-1')
  assert.match(sent.init.headers['tauri-callback'] ?? '', /^\d+$/)
  assert.match(sent.init.headers['tauri-error'] ?? '', /^\d+$/)
  assert.equal(sent.init.headers['tauri-request-id'], undefined)
  assert.equal(sent.init.body, '{"a":1,"b":"x"}')

  const arrived = lastRecorded('demo:echo')
  assert.equal(arrived.method, 'POST')
  assert.equal(arrived.body, '{"a":1,"b":"x"}')
  assert.equal(arrived.headers['tauri-request-id'], undefined)
  assert.equal(arrived.headers['tauri-invoke-key'], 'key-1')
})

test('invoke uses ipc://localhost on non-Windows platforms', async () => {
  recorded = []
  const bridge = new FakeBridge('unix', ['key-unix'])
  const tauri = createTauriClient({ bridge })

  await tauri.invoke('demo:echo', { unix: true })

  const sent = bridge.requests.at(-1)
  assert.ok(sent)
  assert.equal(sent.url, 'ipc://localhost/demo%3Aecho')
})

test('Tauri-Response: error becomes a typed TauriError with the decoded payload', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['key-1'])
  const tauri = createTauriClient({ bridge })

  await assert.rejects(
    tauri.invoke('demo:fail'),
    (error: unknown) => {
      assert.ok(error instanceof TauriError)
      assert.equal(error.code, 'ETAURI')
      assert.equal(error.command, 'demo:fail')
      assert.equal(error.message, 'boom')
      assert.deepEqual(error.payload, { code: 'BOOM', message: 'boom' })
      assert.equal(error.response?.headers['tauri-response'], 'error')
      return true
    },
  )
})

test('raw bytes survive ipc:// and keep Tauri-Response plus all headers', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['key-1'])
  const tauri = createTauriClient({ bridge })

  const raw = await tauri.request<Uint8Array>({
    url: 'ipc://localhost/demo%3Abinary',
    method: 'POST',
    responseType: 'buffer',
  })
  assert.equal(raw.headers['tauri-response'], 'ok')
  assert.ok(raw.data instanceof Uint8Array)
  assert.deepEqual([...raw.data], [0, 1, 2, 255])

  const low = await tauri.ipcRequest<ArrayBuffer>('demo:binary', {
    body: new Uint8Array([9, 8, 7]),
    responseType: 'arraybuffer',
  })
  assert.equal(low.headers['tauri-response'], 'ok')
  assert.ok(low.data instanceof ArrayBuffer)
  assert.deepEqual([...new Uint8Array(low.data)], [0, 1, 2, 255])

  const sent = lastRecorded('demo:binary')
  assert.equal(sent.headers['content-type'], 'application/octet-stream')
  assert.equal(sent.body, '090807')
})

test('invokeRaw defaults to binary data and still maps Tauri errors', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['key-1'])
  const tauri = createTauriClient({ bridge })

  const response = await tauri.invokeRaw('demo:binary', new Uint8Array([1, 2]))
  assert.deepEqual([...response.data], [0, 1, 2, 255])
  assert.equal(response.headers['tauri-response'], 'ok')
})

test('the high-level client times out when the host never answers', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['key-1'])
  const tauri = createTauriClient({ bridge, timeout: 40 })

  await assert.rejects(
    tauri.invoke('demo:slow'),
    (error: unknown) => {
      assert.ok(error instanceof TimeoutError)
      assert.equal(error.code, 'ETIMEOUT')
      return true
    },
  )
})

test('a 401/403 response refreshes the invoke key once', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['stale', 'fresh'])
  const tauri = createTauriClient({ bridge })

  const data = await tauri.invoke<{ key: string }>('demo:key')

  assert.deepEqual(data, { key: 'fresh' })
  assert.equal(bridge.requests.length, 2)
  assert.equal(recorded.filter((entry) => entry.command === 'demo:key').length, 2)
  assert.equal(recorded[0]?.headers['tauri-invoke-key'], 'stale')
  assert.equal(recorded[1]?.headers['tauri-invoke-key'], 'fresh')
})

test('a missing invoke key fails fast instead of hanging', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', [undefined])
  const tauri = createTauriClient({ bridge })

  await assert.rejects(
    tauri.invoke('demo:echo'),
    (error: unknown) => {
      assert.ok(error instanceof IpcError)
      assert.equal(error.code, 'EIPC')
      assert.match(error.message, /invoke key is unavailable/)
      return true
    },
  )
  assert.equal(bridge.requests.length, 0)
})

test('listen registers through Tauri callbacks and unlistens with the returned id', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['key-1'])
  const tauri = createTauriClient({ bridge })
  const payloads: unknown[] = []

  const off = await tauri.listen('my-event', (payload) => {
    payloads.push(payload)
  })

  const register = lastRecorded('plugin:event|listen')
  const args = JSON.parse(register.body) as {
    event: string
    target: { kind: string }
    handler: number
  }
  assert.equal(args.event, 'my-event')
  assert.deepEqual(args.target, { kind: 'Any' })
  assert.equal(typeof args.handler, 'number')

  assert.ok(bridge.callbacks.has(args.handler))
  bridge.runCallback(args.handler, { hello: 1 })
  assert.deepEqual(payloads, [{ hello: 1 }])

  await off()

  const unlisten = lastRecorded('plugin:event|unlisten')
  const unlistenArgs = JSON.parse(unlisten.body) as { event: string; eventId: number }
  assert.equal(unlistenArgs.event, 'my-event')
  assert.equal(unlistenArgs.eventId, 7)
})

test('middleware can intercept requests before they reach the transport', async () => {
  recorded = []
  const bridge = new FakeBridge('windows', ['key-1'])
  const tauri = createTauriClient({
    bridge,
    middlewares: [
      async (request, next) => {
        request.headers['x-policy'] = 'allowed'
        return next()
      },
    ],
  })

  await tauri.invoke('demo:echo', {})

  assert.equal(lastRecorded('demo:echo').headers['x-policy'], 'allowed')
})
