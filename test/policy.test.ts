import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PolicyError,
  createClient,
  evaluatePolicy,
  originOf,
  type FetchOptions,
  type PolicyOptions,
  type RawResponse,
  type Transport,
  type TransportRequest,
} from '../src/index.js'

class CaptureTransport implements Transport {
  readonly name = 'capture'
  readonly requests: TransportRequest[] = []

  supports(url: URL): boolean {
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ipc:'
  }

  send(request: TransportRequest): Promise<RawResponse> {
    this.requests.push(request)
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    })
  }
}

function makeClient(policy?: PolicyOptions, fetchOptions?: FetchOptions) {
  const transport = new CaptureTransport()
  const client = createClient({
    builtins: false,
    transports: [transport],
    policy,
    fetchOptions,
  })
  return { client, transport }
}

function isPolicyError(reason: string, origin: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PolicyError)
    assert.equal(error.code, 'EPOLICY')
    assert.equal(error.reason, reason)
    assert.equal(error.origin, origin)
    return true
  }
}

test('without a policy every URL is allowed', async () => {
  const { client, transport } = makeClient()

  const response = await client.request('https://example.com/data')

  assert.equal(response.status, 200)
  assert.equal(transport.requests.length, 1)

  await client.close()
})

test('deny mode rejects unlisted URLs and lets allow-listed ones through', async () => {
  const { client, transport } = makeClient({
    mode: 'deny',
    allow: ['api.example.com'],
  })

  await client.request('https://api.example.com/users')
  assert.equal(transport.requests.length, 1)

  await assert.rejects(
    client.request('https://other.example.net/data'),
    isPolicyError('not-allowlisted', 'https://other.example.net'),
  )
  assert.equal(transport.requests.length, 1)

  await client.close()
})

test('allow rules match scheme origins, path prefixes and regular expressions', async () => {
  const { client } = makeClient({
    mode: 'deny',
    allow: ['https://api.example.com/v1', /^https:\/\/cdn\.example\.com\//],
  })

  await client.request('https://api.example.com/v1/users')
  await client.request('https://cdn.example.com/a.png')

  await assert.rejects(
    client.request('https://api.example.com/v2/users'),
    isPolicyError('not-allowlisted', 'https://api.example.com'),
  )

  await client.close()
})

test('the deny list wins over the allow list and same-origin', async () => {
  const { client } = makeClient({
    deny: ['tracker.example.com'],
    allow: ['tracker.example.com'],
  })

  await assert.rejects(
    client.request('https://tracker.example.com/pixel'),
    isPolicyError('denied', 'https://tracker.example.com'),
  )

  await client.close()
})

test('denySchemes rejects a scheme even in allow mode', async () => {
  const { client } = makeClient({ denySchemes: ['ipc:'] })

  await assert.rejects(
    client.request('ipc://localhost/echo'),
    isPolicyError('denied-scheme', 'ipc://localhost'),
  )

  await client.close()
})

test('allowSameOrigin is an OR with the allow list and still honours deny rules', async () => {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'https://app.example' },
    configurable: true,
  })

  try {
    const { client } = makeClient({
      mode: 'deny',
      allowSameOrigin: true,
      allow: ['api.example.com'],
    })

    await client.request('https://app.example/data')
    await client.request('https://api.example.com/data')

    await assert.rejects(
      client.request('https://other.example.net/data'),
      isPolicyError('not-allowlisted', 'https://other.example.net'),
    )

    const denied = makeClient({
      mode: 'deny',
      allowSameOrigin: true,
      deny: ['app.example'],
    })
    await assert.rejects(
      denied.client.request('https://app.example/data'),
      isPolicyError('denied', 'https://app.example'),
    )
  } finally {
    Reflect.deleteProperty(globalThis, 'location')
  }
})

test('PolicyError keeps url, method, origin and the caller context verbatim', async () => {
  const chain = ['root.vjson', 'child.vjson']
  const { client } = makeClient({ mode: 'deny', allow: ['api.example.com'] })

  await assert.rejects(
    client.request({
      url: 'https://blocked.example/resource',
      method: 'POST',
      context: chain,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PolicyError)
      assert.equal(error.code, 'EPOLICY')
      assert.equal(error.url, 'https://blocked.example/resource')
      assert.equal(error.method, 'POST')
      assert.equal(error.origin, 'https://blocked.example')
      assert.equal(error.reason, 'not-allowlisted')
      assert.equal(error.context, chain)
      return true
    },
  )

  await client.close()
})

test('the policy runs before caller middleware', async () => {
  let seen = false
  const { client } = makeClient({ mode: 'deny' })
  client.use(async (request, next) => {
    seen = true
    return next()
  })

  await assert.rejects(
    client.request('https://blocked.example/data'),
    isPolicyError('not-allowlisted', 'https://blocked.example'),
  )
  assert.equal(seen, false)

  await client.close()
})

test('fetchOptions are merged from defaults and overridden per request', async () => {
  const { client, transport } = makeClient(undefined, {
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
  })

  await client.request({
    url: 'https://example.com/a',
    fetchOptions: { credentials: 'include' },
  })

  const first = transport.requests[0]
  assert.ok(first)
  assert.deepEqual(first.fetchOptions, {
    mode: 'cors',
    credentials: 'include',
    redirect: 'follow',
  })
  assert.deepEqual(Object.keys(first.fetchOptions ?? {}).sort(), [
    'credentials',
    'mode',
    'redirect',
  ])

  await client.close()
})

test('originOf rebuilds origins for non-special schemes', () => {
  assert.equal(originOf(new URL('https://example.com:8443/a')), 'https://example.com:8443')
  assert.equal(originOf(new URL('ipc://localhost/echo')), 'ipc://localhost')
})

test('evaluatePolicy resets the lastIndex of reusable regex rules', () => {
  const rule = /example\.com/g
  const url = new URL('https://example.com/a')

  assert.equal(evaluatePolicy(url, { allow: [rule] }).allowed, true)
  assert.equal(evaluatePolicy(url, { allow: [rule] }).allowed, true)
})
