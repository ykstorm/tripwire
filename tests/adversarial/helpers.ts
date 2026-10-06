import type { ProxyConfig } from '../../src/proxy/config.js'
import type { UpstreamChunk, UpstreamFactory } from '../../src/proxy/handlers/chat.js'

export function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    upstreamUrl: 'https://api.openai.com/v1',
    customPatterns: [],
    holdback: 48,
    maxStreamMs: 120_000,
    maxStreamChars: 200_000,
    maxConcurrentStreams: 32,
    rateLimitRpm: 60,
    trustProxyHops: 0,
    proxyToken: undefined,
    defaultMaxTokens: 4096,
    ...overrides,
  }
}

export const AUTH = { Authorization: 'Bearer sk-test-fake-key' }
export const BODY = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
}

/** A factory whose client streams the provided chunks. */
export function mockUpstream(chunks: UpstreamChunk[]): UpstreamFactory {
  return () => ({
    chat: {
      completions: {
        async create() {
          async function* gen(): AsyncGenerator<UpstreamChunk> {
            for (const c of chunks) yield c
          }
          return gen()
        },
      },
    },
  })
}

/** Parse an SSE body into its JSON data events (excluding [DONE]). */
export function parseSSE(body: string): unknown[] {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data: '))
    .map((b) => b.slice('data: '.length))
    .filter((d) => d !== '[DONE]')
    .map((d) => JSON.parse(d))
}

export function contentChunk(content: string): UpstreamChunk {
  return { choices: [{ index: 0, delta: { content } }] }
}
