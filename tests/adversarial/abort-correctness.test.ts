import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createProxyServer } from '../../src/proxy/server.js'
import { StreamingGuard } from '../../src/streaming/index.js'
import type { UpstreamChunk, UpstreamFactory } from '../../src/proxy/handlers/chat.js'
import { makeConfig, parseSSE, contentChunk, AUTH, BODY } from './helpers.js'

// Upstream that records generator cleanup and honors the abort signal.
function trackedUpstream(
  chunks: UpstreamChunk[],
  state: { returns: number },
  opts: { slowMs?: number; signalThrows?: boolean } = {}
): UpstreamFactory {
  return () => ({
    chat: {
      completions: {
        async create(_body, createOpts) {
          const signal = createOpts?.signal
          async function* gen(): AsyncGenerator<UpstreamChunk> {
            try {
              for (const c of chunks) {
                if (signal?.aborted) {
                  if (opts.signalThrows) throw new Error('aborted by signal')
                  return
                }
                if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs))
                yield c
              }
            } finally {
              state.returns++
            }
          }
          return gen()
        },
      },
    },
  })
}

describe('abort correctness', () => {
  it('stops at the trip, forwards nothing after it, and cleans up the stream once', async () => {
    const state = { returns: 0 }
    const chunks: UpstreamChunk[] = [
      contentChunk('here is a number 9876543210'),
      ...Array.from({ length: 100 }, () => contentChunk(' LATER')),
    ]
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: trackedUpstream(chunks, state) })
    const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)

    const trip = parseSSE(res.text).find((e) => (e as { error?: string }).error === 'rule_trip')
    expect(trip).toBeTruthy()
    expect(res.text).not.toContain('data: [DONE]')
    expect(res.text).not.toContain('LATER')
    expect(state.returns).toBe(1)
  })

  it('caps a never-ending stream with STREAM_TOO_LARGE', async () => {
    const state = { returns: 0 }
    const chunks = Array.from({ length: 100 }, () => contentChunk('xxxxxxxxxx'))
    const app = createProxyServer({
      config: makeConfig({ maxStreamChars: 100 }),
      upstreamFactory: trackedUpstream(chunks, state),
    })
    const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
    expect(res.text).toContain('stream_too_large')
    expect(res.text).not.toContain('data: [DONE]')
  })

  it('closes a never-ending stream when MAX_STREAM_MS elapses', async () => {
    const state = { returns: 0 }
    const chunks = Array.from({ length: 1000 }, (_, i) => contentChunk(`t${i} `))
    const app = createProxyServer({
      config: makeConfig({ maxStreamMs: 200 }),
      upstreamFactory: trackedUpstream(chunks, state, { slowMs: 40, signalThrows: true }),
    })
    const started = Date.now()
    const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.text).not.toContain('data: [DONE]')
  })

  it('passes an abort signal through to the upstream client', async () => {
    let sawSignal = false
    const factory: UpstreamFactory = () => ({
      chat: {
        completions: {
          async create(_body, createOpts) {
            sawSignal = createOpts?.signal instanceof AbortSignal
            async function* gen(): AsyncGenerator<UpstreamChunk> {
              yield contentChunk('ok')
            }
            return gen()
          },
        },
      },
    })
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: factory })
    await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
    expect(sawSignal).toBe(true)
  })

  it('logs one violation per label even across 200 soft-matching chunks', () => {
    const g = new StreamingGuard()
    g.onChunk('the final price is ₹45,000 ')
    for (let i = 0; i < 200; i++) g.onChunk('and more neutral text ')
    expect(g.violations.filter((v) => v.includes('PRICE_COMMITMENT_LEAK'))).toHaveLength(1)
  })
})
