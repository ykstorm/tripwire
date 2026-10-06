import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createProxyServer } from '../../src/proxy/server.js'
import { loadConfig, ConfigError } from '../../src/proxy/config.js'
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

  it('keys the bucket on the address the trusted proxy saw, not on what the client wrote in X-Forwarded-For', async () => {
    const config = loadConfig({ TRIPWIRE_TRUST_PROXY: '1', TRIPWIRE_RATE_LIMIT_RPM: '2' } as NodeJS.ProcessEnv)
    const app = createProxyServer({ config, upstreamFactory: mockUpstream([contentChunk('ok')]) })
    const codes: number[] = []
    for (let i = 0; i < 6; i++) {
      // The client invents a new address each time; the proxy in front appends the real one.
      const res = await request(app)
        .post('/v1/chat/completions')
        .set(AUTH)
        .set('X-Forwarded-For', `10.0.0.${i}, 203.0.113.7`)
        .send(BODY)
      codes.push(res.status)
    }
    expect(codes.filter((c) => c === 429)).toHaveLength(4)
  })

  it('rejects a rate limit of 0 at config time instead of answering Retry-After: Infinity', () => {
    expect(() => loadConfig({ TRIPWIRE_RATE_LIMIT_RPM: '0' } as NodeJS.ProcessEnv)).toThrow(ConfigError)
    expect(() => loadConfig({ TRIPWIRE_RATE_LIMIT_RPM: '0' } as NodeJS.ProcessEnv)).toThrow(/TRIPWIRE_RATE_LIMIT_RPM must be at least 1/)
  })

  it('rejects a TRIPWIRE_TRUST_PROXY value that is neither a flag nor a hop count', () => {
    expect(() => loadConfig({ TRIPWIRE_TRUST_PROXY: 'loopback' } as NodeJS.ProcessEnv)).toThrow(ConfigError)
    expect(loadConfig({ TRIPWIRE_TRUST_PROXY: '2' } as NodeJS.ProcessEnv).trustProxyHops).toBe(2)
    expect(loadConfig({} as NodeJS.ProcessEnv).trustProxyHops).toBe(0)
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
