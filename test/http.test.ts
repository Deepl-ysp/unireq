import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import {
  HttpError,
  NetworkError,
  ParseError,
  TimeoutError,
  CancelError,
  request,
} from '../src/index.js'
import { startTestServer, type TestServer } from './helpers.js'

interface EchoData {
  method: string
  path: string
  search: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

let server: TestServer
let baseUrl: string

before(async () => {
  server = await startTestServer()
  baseUrl = server.baseUrl
})

after(async () => {
  await server.close()
})

test('GET returns parsed JSON with status, headers and raw body', async () => {
  const response = await request<EchoData>(`${baseUrl}/echo`)

  assert.equal(response.status, 200)
  assert.equal(response.data.method, 'GET')
  assert.equal(response.data.path, '/echo')
  assert.match(response.headers['content-type'] ?? '', /application\/json/)
  assert.ok(response.raw.body.byteLength > 0)
})

test('serializes query parameters including arrays and dates', async () => {
  const date = new Date('2026-01-01T00:00:00.000Z')
  const response = await request<EchoData>({
    url: `${baseUrl}/echo`,
    query: {
      tag: ['a', 'b', 'c'],
      page: 2,
      keep: true,
      skip: undefined,
      empty: null,
      date,
    },
  })

  const params = new URLSearchParams(response.data.search)
  assert.deepEqual(params.getAll('tag'), ['a', 'b', 'c'])
  assert.equal(params.get('page'), '2')
  assert.equal(params.get('keep'), 'true')
  assert.equal(params.get('skip'), null)
  assert.equal(params.get('empty'), null)
  assert.equal(params.get('date'), date.toISOString())
})

test('auto-decodes text and binary responses', async () => {
  const text = await request<string>(`${baseUrl}/text`)
  assert.equal(text.data, 'hello unireq')

  const binary = await request<Uint8Array>(`${baseUrl}/binary`)
  assert.ok(binary.data instanceof Uint8Array)
  assert.deepEqual([...binary.data], [0, 1, 2, 255])
})

test('responseType can override content-type based decoding', async () => {
  const response = await request<string>({ url: `${baseUrl}/echo`, responseType: 'text' })
  assert.equal(typeof response.data, 'string')
  assert.match(response.data, /"method":"GET"/)
})

test('non-2xx responses throw HttpError with raw context', async () => {
  await assert.rejects(
    request(`${baseUrl}/missing`),
    (error: unknown) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.code, 'EHTTP')
      assert.equal(error.status, 404)
      assert.equal(error.response?.status, 404)
      assert.equal(error.method, 'GET')
      return true
    },
  )
})

test('an empty JSON body decodes to null', async () => {
  const response = await request<null>(`${baseUrl}/empty-json`)
  assert.equal(response.status, 200)
  assert.equal(response.data, null)
})

test('invalid JSON throws ParseError', async () => {
  await assert.rejects(
    request(`${baseUrl}/bad-json`),
    (error: unknown) => {
      assert.ok(error instanceof ParseError)
      assert.equal(error.code, 'EPARSE')
      assert.equal(error.response?.status, 200)
      return true
    },
  )
})

test('timeout throws TimeoutError', async () => {
  await assert.rejects(
    request({ url: `${baseUrl}/slow?ms=300`, timeout: 60 }),
    (error: unknown) => {
      assert.ok(error instanceof TimeoutError)
      assert.equal(error.code, 'ETIMEOUT')
      assert.equal(error.timeoutMs, 60)
      return true
    },
  )
})

test('AbortSignal cancellation throws CancelError', async () => {
  const controller = new AbortController()
  const pending = request({ url: `${baseUrl}/slow?ms=300`, signal: controller.signal })
  setTimeout(() => controller.abort(), 20)

  await assert.rejects(
    pending,
    (error: unknown) => {
      assert.ok(error instanceof CancelError)
      assert.equal(error.code, 'ECANCEL')
      return true
    },
  )
})

test('retries 5xx responses and eventually succeeds', async () => {
  server.resetFlaky()

  const response = await request<{ hit: number }>({
    url: `${baseUrl}/flaky`,
    retry: { count: 2, delayMs: 5 },
  })

  assert.equal(response.status, 200)
  assert.equal(response.data.hit, 3)
  assert.equal(server.flakyHits(), 3)
})

test('connection failures throw NetworkError', async () => {
  const temporary = createServer()
  await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve))
  const port = (temporary.address() as AddressInfo).port
  await new Promise<void>((resolve) => temporary.close(() => resolve()))

  await assert.rejects(
    request(`http://127.0.0.1:${port}/unreachable`),
    (error: unknown) => {
      assert.ok(error instanceof NetworkError)
      assert.equal(error.code, 'ENETWORK')
      return true
    },
  )
})
