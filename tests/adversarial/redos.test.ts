import { describe, it, expect } from 'vitest'
import { parseCustomPatterns, maxStarHeight, ConfigError } from '../../src/proxy/config.js'
import { checkResponse, MAX_CHECK_CHARS, InputTooLargeError } from '../../src/check/index.js'
import { StreamingGuard, ChunkTooLargeError, MAX_CHUNK_CHARS } from '../../src/streaming/index.js'

function elapsed(fn: () => void): number {
  const t0 = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - t0) / 1e6
}

describe('custom pattern loading is fail-fast', () => {
  it('rejects malformed JSON (no silent empty fallback)', () => {
    expect(() => parseCustomPatterns('{not json')).toThrow(ConfigError)
  })

  it('rejects a nested-quantifier pattern (star height > 1)', () => {
    expect(maxStarHeight('(a+)+$')).toBeGreaterThan(1)
    const blob = JSON.stringify([{ source: '(a+)+$', label: 'EVIL', mode: 'abort' }])
    expect(() => parseCustomPatterns(blob)).toThrow(ConfigError)
  })

  it('rejects disallowed flags (g, y)', () => {
    const g = JSON.stringify([{ source: 'abc', flags: 'g', label: 'X', mode: 'observe' }])
    const y = JSON.stringify([{ source: 'abc', flags: 'y', label: 'X', mode: 'observe' }])
    expect(() => parseCustomPatterns(g)).toThrow(ConfigError)
    expect(() => parseCustomPatterns(y)).toThrow(ConfigError)
  })

  it('accepts a sane pattern with allowed flags', () => {
    const ok = JSON.stringify([{ source: 'secret-\\w+', flags: 'i', label: 'OK', mode: 'observe' }])
    const parsed = parseCustomPatterns(ok)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].label).toBe('OK')
  })
})

describe('built-in patterns are linear on adversarial input', () => {
  it('builder candidate scan stays fast on repeated capitalized words', () => {
    const payload = 'Aa '.repeat(20000) + '!'
    const ms = elapsed(() => checkResponse(payload, { knownBuilderNames: ['Real Group'] }))
    expect(ms).toBeLessThan(1000)
  })

  it('price-guarantee scan stays fast on a repeated keyword', () => {
    const payload = 'guarantee '.repeat(5000) + 'x'
    const ms = elapsed(() => checkResponse(payload))
    expect(ms).toBeLessThan(1000)
  })
})

describe('input size caps', () => {
  it('checkResponse throws INPUT_TOO_LARGE past the cap', () => {
    const big = 'a'.repeat(MAX_CHECK_CHARS + 1)
    expect(() => checkResponse(big)).toThrow(InputTooLargeError)
  })

  it('onChunk throws CHUNK_TOO_LARGE past the cap', () => {
    const g = new StreamingGuard()
    expect(() => g.onChunk('a'.repeat(MAX_CHUNK_CHARS + 1))).toThrow(ChunkTooLargeError)
  })
})
