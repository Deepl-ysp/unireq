import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  CancelError,
  InvalidRequestError,
  IpcError,
  createClient,
  request,
  type RawResponse,
  type Transport,
  type TransportRequest,
} from '../src/index.js'
import { startTestServer, type TestServer } from './helpers.js'

interface EchoData {
  method: string
  path: string
  search: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

class MockTransport implements Transport {
  readonly name = 'mock'

  supports(url: URL): boolean {
    return url.protocol === 'mock:'
  }

  send(input: TransportRequest): Promise<RawResponse> {
    const body = Buffer.from(
      JSON.stringify({
        url: input.url,
        method: input.method,
        hasBody: input.body !== undefined,
      }),
    )
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    })
  }
}

/** Stand-in for a future Electron/Tauri adapter that takes over the ipc:// scheme. */
class MockIpcTransport implements Transport {
  readonly name = 'mock-ipc'

  supports(url: URL): boolean {
    return url.protocol === 'ipc:'
  }

  send(input: TransportRequest): Promise<RawResponse> {
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ via: 'mock-ipc', url: input.url })),
    })
  }
}

let server: TestServer

before(async () => {
  server = await startTestServer()
})

after(async () => {
  await server.close()
})

test('client defaults, middleware onion order, query and JSON body work together', async () => {
  const order: string[] = []
  const client = createClient({
    baseUrl: server.baseUrl,
    headers: { 'X-Default': 'yes', 'X-Shared': 'default' },
    timeout: 2000,
  })

  client.use(async (request, next) => {
    order.push('outer:before')
    request.headers['x-mw'] = 'outer'
    const response = await next()
    order.push('outer:after')
    response.headers['x-mw-after'] = '1'
    return response
  })

  client.use(async (request, next) => {
    order.push('inner:before')
    request.headers['x-inner'] = '1'
    const response = await next()
    order.push('inner:after')
    return response
  })

  const response = await client.request<EchoData>({
    url: '/echo?existing=1',
    method: 'post',
    headers: { 'x-shared': 'override' },
    query: { page: 2, tag: ['a', 'b'] },
    body: { hello: 'world' },
  })

  assert.deepEqual(order, ['outer:before', 'inner:before', 'inner:after', 'outer:after'])
  assert.equal(response.data.method, 'POST')
  assert.equal(response.data.headers['x-default'], 'yes')
  assert.equal(response.data.headers['x-shared'], 'override')
  assert.equal(response.data.headers['x-mw'], 'outer')
  assert.equal(response.data.headers['x-inner'], '1')
  assert.equal(response.data.headers['content-type'], 'application/json')
  assert.equal(response.headers['x-mw-after'], '1')

  const params = new URLSearchParams(response.data.search)
  assert.equal(params.get('existing'), '1')
  assert.equal(params.get('page'), '2')
  assert.deepEqual(params.getAll('tag'), ['a', 'b'])

  assert.deepEqual(JSON.parse(response.data.body), { hello: 'world' })
  assert.equal(response.raw.status, 200)
  assert.ok(response.raw.body.byteLength > 0)

  await client.close()
})

test('a custom transport can be registered without touching the core', async () => {
  const client = createClient({ transports: [new MockTransport()] })

  const response = await client.request<{ url: string; method: string; hasBody: boolean }>({
    url: 'mock://demo/resource',
    method: 'POST',
    body: 'payload',
  })

  assert.equal(response.status, 200)
  assert.equal(response.data.method, 'POST')
  assert.equal(response.data.url, 'mock://demo/resource')
  assert.equal(response.data.hasBody, true)

  await client.close()
})

test('ipc:// fails fast when no Tauri invoke key is available', async () => {
  await assert.rejects(
    request('ipc://localhost/echo'),
    (error: unknown) => {
      assert.ok(error instanceof IpcError)
      assert.equal(error.code, 'EIPC')
      assert.match(error.message, /invoke key is unavailable/)
      return true
    },
  )
})

test('a later transport registration can replace the ipc placeholder', async () => {
  const client = createClient({ transports: [new MockIpcTransport()] })

  const response = await client.request<{ via: string; url: string }>('ipc://tauri/echo')

  assert.equal(response.status, 200)
  assert.equal(response.data.via, 'mock-ipc')
  assert.equal(response.data.url, 'ipc://tauri/echo')

  await client.close()
})

test('unknown schemes are rejected before any transport runs', async () => {
  await assert.rejects(
    request('ftp://example.invalid/file'),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError)
      assert.equal(error.code, 'EINVALID')
      return true
    },
  )
})

test('relative URLs without baseUrl are invalid', async () => {
  await assert.rejects(
    request('/relative'),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError)
      assert.equal(error.code, 'EINVALID')
      return true
    },
  )
})

test('an already-aborted signal cancels before sending', async () => {
  const controller = new AbortController()
  controller.abort()

  const client = createClient({ baseUrl: server.baseUrl })
  await assert.rejects(
    client.request({ url: '/echo', signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof CancelError)
      assert.equal(error.code, 'ECANCEL')
      return true
    },
  )

  await client.close()
})
