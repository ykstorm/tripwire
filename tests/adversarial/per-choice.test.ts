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

  it('forwards held tool_call deltas when the upstream ends without a finish_reason', () => {
    const chunks: UpstreamChunk[] = [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"city":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Mumbai"}' } }] } }] },
    ]
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: mockUpstream(chunks) })
    return request(app)
      .post('/v1/chat/completions')
      .set(AUTH)
      .send(BODY)
      .then((res) => {
        expect(tripOf(res.text)).toBeUndefined()
        const events = parseSSE(res.text) as Array<{ choices?: Array<{ delta: { tool_calls?: Array<{ id?: string; function?: { arguments?: string } }> } }> }>
        const calls = events.flatMap((e) => e.choices ?? []).flatMap((c) => c.delta.tool_calls ?? [])
        expect(calls.map((tc) => tc.function?.arguments ?? '').join('')).toBe('{"city":"Mumbai"}')
        expect(calls[0]?.id).toBe('call_1')
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

  describe('held aux deltas released together are folded into one delta', () => {
    type ForwardedDelta = {
      role?: string
      refusal?: string
      tool_calls?: Array<{ id?: string; function?: { arguments?: string } }>
      function_call?: { name?: string; arguments?: string }
    }
    type ForwardedChoice = { delta: ForwardedDelta; finish_reason: string | null }

    async function forwardedChoices(chunks: UpstreamChunk[]): Promise<ForwardedChoice[]> {
      const app = createProxyServer({ config: makeConfig(), upstreamFactory: mockUpstream(chunks) })
      const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
      expect(tripOf(res.text)).toBeUndefined()
      expect(res.text).toContain('data: [DONE]')
      const events = parseSSE(res.text) as Array<{ choices?: ForwardedChoice[] }>
      return events.flatMap((e) => e.choices ?? [])
    }

    const finish = (reason: string): UpstreamChunk => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })

    it('concatenates refusal text', async () => {
      const choices = await forwardedChoices([
        { choices: [{ index: 0, delta: { role: 'assistant', refusal: 'I cannot ' } }] },
        { choices: [{ index: 0, delta: { refusal: 'help with that.' } }] },
        finish('stop'),
      ])
      expect(choices).toEqual([
        { index: 0, delta: { role: 'assistant' }, finish_reason: null },
        { index: 0, delta: { refusal: 'I cannot help with that.' }, finish_reason: 'stop' },
      ])
    })

    it('keeps the function_call name from the first delta and concatenates its arguments', async () => {
      const choices = await forwardedChoices([
        { choices: [{ index: 0, delta: { role: 'assistant', function_call: { name: 'lookup', arguments: '{"city":' } } }] },
        { choices: [{ index: 0, delta: { function_call: { arguments: '"Mumbai"}' } } }] },
        finish('function_call'),
      ])
      expect(choices).toEqual([
        { index: 0, delta: { role: 'assistant' }, finish_reason: null },
        {
          index: 0,
          delta: { function_call: { name: 'lookup', arguments: '{"city":"Mumbai"}' } },
          finish_reason: 'function_call',
        },
      ])
    })

    it('lets a later function_call name replace an earlier one', async () => {
      const choices = await forwardedChoices([
        { choices: [{ index: 0, delta: { function_call: { name: 'first', arguments: '{' } } }] },
        { choices: [{ index: 0, delta: { function_call: { name: 'second', arguments: '}' } } }] },
        finish('function_call'),
      ])
      expect(choices).toEqual([
        { index: 0, delta: { function_call: { name: 'second', arguments: '{}' } }, finish_reason: 'function_call' },
      ])
    })

    it('gives a function_call with no arguments an empty arguments string when it rides with a refusal', async () => {
      const choices = await forwardedChoices([
        { choices: [{ index: 0, delta: { refusal: 'No.', function_call: { name: 'lookup' } } }] },
        finish('stop'),
      ])
      expect(choices).toEqual([
        { index: 0, delta: { refusal: 'No.', function_call: { name: 'lookup', arguments: '' } }, finish_reason: 'stop' },
      ])
    })

    it('appends tool_calls and refusal from separate deltas into the same folded delta', async () => {
      const choices = await forwardedChoices([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { arguments: '{}' } }] } }] },
        { choices: [{ index: 0, delta: { refusal: 'Partly.' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { arguments: '[]' } }] } }] },
        finish('tool_calls'),
      ])
      expect(choices).toEqual([
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { arguments: '{}' } },
              { index: 1, id: 'call_2', function: { arguments: '[]' } },
            ],
            refusal: 'Partly.',
          },
          finish_reason: 'tool_calls',
        },
      ])
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
