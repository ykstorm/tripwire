import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createProxyServer } from '../../src/proxy/server.js'
import type { UpstreamFactory } from '../../src/proxy/handlers/chat.js'
import { redact } from '../../src/proxy/lib/redact.js'
import { makeConfig, AUTH, BODY } from './helpers.js'

const SECRET = 'sk-live_ABCDEFGHIJKLMNOPQRST12345'
const INTERNAL_IP = '10.0.0.5'

// Upstream whose create() rejects with an error message that embeds a secret.
function leakyUpstream(): UpstreamFactory {
  return () => ({
    chat: {
      completions: {
        async create() {
          throw new Error(`401 from ${INTERNAL_IP}: Authorization Bearer ${SECRET} rejected`)
        },
      },
    },
  })
}

describe('secret redaction in errors + logs', () => {
  it('redact() strips secrets and Bearer tokens', () => {
    expect(redact(`key ${SECRET} here`)).not.toContain(SECRET)
    expect(redact(`Authorization: Bearer ${SECRET}`)).toContain('Bearer ***')
  })

  it('client never sees the secret or upstream error detail on failure', () => {
    const app = createProxyServer({ config: makeConfig(), upstreamFactory: leakyUpstream() })
    return request(app)
      .post('/v1/chat/completions')
      .set(AUTH)
      .send(BODY)
      .then((res) => {
        expect(res.status).toBe(502)
        expect(res.body.error).toBe('upstream_failure')
        const raw = JSON.stringify(res.body)
        expect(raw).not.toContain(SECRET)
        expect(raw).not.toContain(INTERNAL_IP)
      })
  })
})

describe('server hardening headers', () => {
  it('does not advertise x-powered-by', () => {
    const app = createProxyServer({ config: makeConfig() })
    return request(app)
      .get('/healthz')
      .then((res) => {
        expect(res.headers['x-powered-by']).toBeUndefined()
      })
  })
})
