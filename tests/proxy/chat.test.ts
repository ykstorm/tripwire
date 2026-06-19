import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createProxyServer } from '../../src/proxy/server.js'
import type { UpstreamChunk, UpstreamFactory } from '../../src/proxy/handlers/chat.js'

// ---- Test helpers: a mock upstream that yields the given content tokens. ----

function chunk(content: string): UpstreamChunk {
  return { choices: [{ delta: { content } }] }
}

/** Build a factory whose client streams the provided tokens. */
function mockUpstream(tokens: string[]): UpstreamFactory {
  return () => ({
    chat: {
      completions: {
        async create() {
          async function* gen() {
            for (const t of tokens) yield chunk(t)
          }
          return gen()
        },
      },
    },
  })
}

/** A factory whose create() rejects — simulates a bad upstream / bad key. */
function failingUpstream(): UpstreamFactory {
  return () => ({
    chat: {
      completions: {
        async create() {
          throw new Error('401 Incorrect API key provided')
        },
      },
    },
  })
}

/** Parse an SSE body into the list of JSON data events (excluding [DONE]). */
function parseSSE(body: string): unknown[] {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data: '))
    .map((b) => b.slice('data: '.length))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d))
}

const AUTH = { Authorization: 'Bearer sk-test-fake-key' }
const BODY = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }

describe('POST /v1/chat/completions (guarded proxy)', () => {
  it('(1) benign prompt → chunks stream through, no abort, ends with [DONE]', async () => {
    const app = createProxyServer({ upstreamFactory: mockUpstream(['Hello', ' ', 'world']) })
    const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)

    expect(res.status).toBe(200)
    expect(res.text).toContain('data: [DONE]')
    const events = parseSSE(res.text)
    // No rule_trip event.
    expect(events.some((e) => (e as { error?: string }).error === 'rule_trip')).toBe(false)
    // All three tokens forwarded.
    const forwarded = events
      .map((e) => (e as UpstreamChunk).choices?.[0]?.delta?.content ?? '')
      .join('')
    expect(forwarded).toBe('Hello world')
  })

  it('(2) banned-pattern prompt → rule_trip SSE event + connection closes mid-stream', async () => {
    // The upstream "model" emits a phone number partway through. CONTACT_LEAK
    // is a hard-abort rule → the stream must abort before the banned token.
    const app = createProxyServer({
      upstreamFactory: mockUpstream(['Sure, ', 'call us at ', '9988776655', ' anytime']),
    })
    const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)

    const events = parseSSE(res.text)
    const trip = events.find((e) => (e as { error?: string }).error === 'rule_trip') as
      | { error: string; rule: string }
      | undefined
    expect(trip).toBeTruthy()
    expect(trip?.rule).toBe('CONTACT_LEAK')

    // The banned token must NOT have been forwarded to the client.
    const forwarded = events
      .filter((e) => (e as UpstreamChunk).choices)
      .map((e) => (e as UpstreamChunk).choices?.[0]?.delta?.content ?? '')
      .join('')
    expect(forwarded).not.toContain('9988776655')
    // Stream did not reach [DONE] — it aborted.
    expect(res.text).not.toContain('data: [DONE]')
  })

  it('(3) soft pattern → full stream completes + logged warning (no abort)', async () => {
    // A price-commitment phrase is observe-only → stream completes normally.
    const app = createProxyServer({
      upstreamFactory: mockUpstream(['The final price is ', '₹45,000 per sqft']),
    })
    const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)

    expect(res.status).toBe(200)
    expect(res.text).toContain('data: [DONE]')
    const events = parseSSE(res.text)
    expect(events.some((e) => (e as { error?: string }).error === 'rule_trip')).toBe(false)
  })

  it('(3b) custom env pattern fires and aborts mid-stream', async () => {
    process.env.TRIPWIRE_CUSTOM_PATTERNS = JSON.stringify([
      { source: 'launch-codes', label: 'CUSTOM_SECRET', mode: 'abort' },
    ])
    try {
      const app = createProxyServer({
        upstreamFactory: mockUpstream(['Here are the ', 'launch-codes', ' for you']),
      })
      const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
      const events = parseSSE(res.text)
      const trip = events.find((e) => (e as { error?: string }).error === 'rule_trip') as
        | { rule: string }
        | undefined
      expect(trip?.rule).toBe('CUSTOM_SECRET')
    } finally {
      delete process.env.TRIPWIRE_CUSTOM_PATTERNS
    }
  })

  it('(4) missing auth → 401', async () => {
    const app = createProxyServer({ upstreamFactory: mockUpstream(['hi']) })
    const res = await request(app).post('/v1/chat/completions').send(BODY)
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('missing_auth')
  })

  it('(5) bad upstream → 502', async () => {
    const app = createProxyServer({ upstreamFactory: failingUpstream() })
    const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('upstream_failure')
  })
})

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const app = createProxyServer()
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})
