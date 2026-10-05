import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createProxyServer } from '../../src/proxy/server.js'
import type { UpstreamChunk } from '../../src/proxy/handlers/chat.js'
import { makeConfig, mockUpstream, parseSSE, AUTH, BODY } from './helpers.js'

function tripOf(body: string): { rule?: string } | undefined {
  return parseSSE(body).find((e) => (e as { error?: string }).error === 'rule_trip') as
    | { rule: string }
    | undefined
}

describe('per-choice buffering + scanning every delta field', () => {
  it('trips on a phone split across two tool_call argument deltas', () => {
    const chunks: UpstreamChunk[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '98765' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '43210' } }] } }] },
    ]
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: mockUpstream(chunks) })
    return request(app)
      .post('/v1/chat/completions')
      .set(AUTH)
      .send(BODY)
      .then((res) => {
        const trip = tripOf(res.text)
        expect(trip?.rule).toBe('CONTACT_LEAK')
        expect(res.text).not.toContain('data: [DONE]')
        // The first half was held back, not forwarded ahead of the trip.
        expect(res.text).not.toContain('98765')
      })
  })

  it('forwards benign tool_call deltas once the aux guard releases them, with arguments intact', () => {
    const chunks: UpstreamChunk[] = [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"city":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Mumbai"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: mockUpstream(chunks) })
    return request(app)
      .post('/v1/chat/completions')
      .set(AUTH)
      .send(BODY)
      .then((res) => {
        expect(tripOf(res.text)).toBeUndefined()
        const events = parseSSE(res.text) as Array<{ choices?: Array<{ delta: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> }>
        const args = events
          .flatMap((e) => e.choices ?? [])
          .flatMap((c) => c.delta.tool_calls ?? [])
          .map((tc) => tc.function?.arguments ?? '')
          .join('')
        expect(args).toBe('{"city":"Mumbai"}')
        expect(res.text).toContain('data: [DONE]')
      })
  })

  it('trips on a secret carried in delta.refusal', () => {
    const chunks: UpstreamChunk[] = [
      { choices: [{ index: 0, delta: { refusal: 'I cannot, but the key is sk-proj-AbCdEfGhIjKlMnOpQrStUv123' } }] },
    ]
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: mockUpstream(chunks) })
    return request(app)
      .post('/v1/chat/completions')
      .set(AUTH)
      .send(BODY)
      .then((res) => {
        const trip = tripOf(res.text)
        expect(trip?.rule).toBe('SECRET_LEAK')
        expect(res.text).not.toContain('sk-proj-AbCdEfGhIjKlMnOpQrStUv123')
      })
  })

  it('rejects n > 1 with 400', () => {
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: mockUpstream([]) })
    return request(app)
      .post('/v1/chat/completions')
      .set(AUTH)
      .send({ ...BODY, n: 2 })
      .then((res) => {
        expect(res.status).toBe(400)
        expect(res.body.error).toBe('invalid_request')
      })
  })
})
