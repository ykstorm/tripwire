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

  it('reads [] and [^] as JavaScript does, so a nested quantifier after them is still caught', () => {
    expect(maxStarHeight('[^](a+)+$')).toBeGreaterThan(1)
    expect(maxStarHeight('[](a+)+$')).toBeGreaterThan(1)
    expect(maxStarHeight('[\\]]+')).toBe(1)
  })

  it('rejects a nested-quantifier pattern (star height > 1)', () => {
    expect(maxStarHeight('(a+)+$')).toBeGreaterThan(1)
    const blob = JSON.stringify([{ source: '(a+)+$', label: 'EVIL', mode: 'abort' }])
    expect(() => parseCustomPatterns(blob)).toThrow(ConfigError)
  })

  it('fails fast on a pattern whose probe would never finish, instead of hanging the boot', () => {
    // Both pass the star-height walk (height 1); the probe is what catches them.
    for (const source of ['(a|a)+$', '(\\d|\\d)+$']) {
      expect(maxStarHeight(source)).toBe(1)
      const blob = JSON.stringify([{ source, label: 'SLOW', mode: 'abort' }])
      const t0 = Date.now()
      expect(() => parseCustomPatterns(blob), source).toThrow(ConfigError)
      expect(Date.now() - t0, source).toBeLessThan(3000)
    }
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

  it.each([undefined, '', '   '])('reads %j as no custom patterns', (raw) => {
    expect(parseCustomPatterns(raw)).toEqual([])
  })

  it.each([
    ['a JSON object instead of an array', '{"source":"a"}', /must be a JSON array/],
    ['a null entry', '[null]', /custom pattern\[0\] needs string "source" and "label"/],
    ['an entry without a source', '[{"label":"X","mode":"abort"}]', /custom pattern\[0\] needs string "source" and "label"/],
    ['an entry without a label', '[{"source":"a","mode":"abort"}]', /custom pattern\[0\] needs string "source" and "label"/],
    ['a numeric source', '[{"source":1,"label":"X","mode":"abort"}]', /custom pattern\[0\] needs string "source" and "label"/],
    ['the index of the first bad entry', '[{"source":"a","label":"A","mode":"abort"},{"source":"b"}]', /custom pattern\[1\] needs/],
    ['a missing mode', '[{"source":"a","label":"X"}]', /custom pattern "X" mode must be "abort" or "observe"/],
    ['an unknown mode', '[{"source":"a","label":"X","mode":"block"}]', /custom pattern "X" mode must be "abort" or "observe"/],
    ['a disallowed flag', '[{"source":"a","flags":"ig","label":"X","mode":"abort"}]', /custom pattern "X" has disallowed flags "ig"/],
    ['a nested quantifier', '[{"source":"(a*)*","label":"X","mode":"abort"}]', /custom pattern "X" has nested unbounded quantifiers/],
    ['a source that does not compile', '[{"source":"(","label":"X","mode":"abort"}]', /custom pattern "X" failed to compile/],
    ['a repeated flag', '[{"source":"a","flags":"ii","label":"X","mode":"abort"}]', /custom pattern "X" failed to compile/],
  ])('rejects %s with a message that names the problem', (_name, raw, message) => {
    expect(() => parseCustomPatterns(raw)).toThrow(ConfigError)
    expect(() => parseCustomPatterns(raw)).toThrow(message)
  })

  it('checks the mode before the flags and the flags before compiling', () => {
    const blob = '[{"source":"(","flags":"g","label":"X","mode":"block"}]'
    expect(() => parseCustomPatterns(blob)).toThrow(/mode must be "abort" or "observe"/)
    const badFlags = '[{"source":"(","flags":"g","label":"X","mode":"abort"}]'
    expect(() => parseCustomPatterns(badFlags)).toThrow(/disallowed flags "g"/)
  })

  it('defaults the flags to case-insensitive and keeps label and mode', () => {
    const [p] = parseCustomPatterns('[{"source":"secret","label":"S","mode":"observe"}]')
    expect(p.pattern.flags).toBe('i')
    expect(p.pattern.source).toBe('secret')
    expect(p.label).toBe('S')
    expect(p.mode).toBe('observe')
  })

  it('keeps explicit flags, including none', () => {
    const [none, multi] = parseCustomPatterns(
      '[{"source":"a","flags":"","label":"N","mode":"abort"},{"source":"b","flags":"ms","label":"M","mode":"abort"}]'
    )
    expect(none.pattern.flags).toBe('')
    expect(multi.pattern.flags).toBe('ms')
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
