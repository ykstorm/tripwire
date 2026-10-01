import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createProxyServer } from '../../src/proxy/server.js'
import type { UpstreamChunk, UpstreamFactory } from '../../src/proxy/handlers/chat.js'
import { makeConfig, mockUpstream, contentChunk, AUTH, BODY } from './helpers.js'

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the per-IP bucket is empty', async () => {
    const app = createProxyServer({
      config: makeConfig({ rateLimitRpm: 2 }),
      upstreamFactory: mockUpstream([contentChunk('ok')]),
    })
    const codes: number[] = []
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
      codes.push(res.status)
      if (res.status === 429) {
        expect(res.headers['retry-after']).toBeDefined()
        expect(res.body.error).toBe('rate_limited')
      }
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1)
  })

  it('exempts /healthz from the rate limit', async () => {
    const app = createProxyServer({ config: makeConfig({ rateLimitRpm: 1 }), upstreamFactory: mockUpstream([]) })
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/healthz')
      expect(res.status).toBe(200)
    }
  })
})

describe('concurrency limiting', () => {
  it('returns 503 when the global in-flight limit is reached', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    // Upstream that holds the slot open until released.
    const blocking: UpstreamFactory = () => ({
      chat: {
        completions: {
          async create() {
            async function* gen(): AsyncGenerator<UpstreamChunk> {
              await gate
              yield contentChunk('done')
            }
            return gen()
          },
        },
      },
    })
    const app = createProxyServer({ config: makeConfig({ maxConcurrentStreams: 1 }), upstreamFactory: blocking })

    // Start the first request (supertest is lazy until .then) so it occupies the slot.
    const firstP = request(app).post('/v1/chat/completions').set(AUTH).send(BODY).then((r) => r)
    await new Promise((r) => setTimeout(r, 100))
    const second = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
    expect(second.status).toBe(503)
    expect(second.body.error).toBe('too_many_concurrent_streams')

    release()
    await firstP
  })
})
