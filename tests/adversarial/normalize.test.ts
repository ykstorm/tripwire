import { describe, it, expect } from 'vitest'
import { normalize } from '../../src/normalize.js'
import { StreamingGuard, GuardAbortError } from '../../src/streaming/index.js'
import { checkResponse } from '../../src/check/index.js'
import { PHONE_PATTERN, SECRET_LEAK_PATTERN } from '../../src/patterns/index.js'

// Feed chunks into a guard and return whether it hard-aborted.
function aborts(chunks: string[]): boolean {
  const g = new StreamingGuard({ holdback: 4 })
  try {
    for (const c of chunks) g.onChunk(c)
    g.flush()
    return false
  } catch (e) {
    return e instanceof GuardAbortError
  }
}

// Split a string into n roughly-equal chunks.
function split(s: string, n: number): string[] {
  const out: string[] = []
  const size = Math.ceil(s.length / n)
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

describe('normalize', () => {
  it('strips zero-width format characters', () => {
    expect(normalize('sk-​proj')).toBe('sk-proj')
    expect(normalize('98​765')).toBe('98765')
  })

  it('folds full-width digits and letters (NFKC)', () => {
    expect(normalize('９８７６５')).toBe('98765')
  })

  it('maps Devanagari and Gujarati digits to ASCII', () => {
    expect(normalize('९८७६५ ४३२१०')).toBe('98765 43210') // Devanagari
    expect(normalize('૯૮૭૬૫૪૩૨૧૦')).toBe('9876543210') // Gujarati
  })

  it('folds dash look-alikes to ASCII hyphen', () => {
    expect(normalize('sk–proj')).toBe('sk-proj') // en dash
    expect(normalize('98765—43210')).toBe('98765-43210') // em dash
  })
})

describe('phone pattern precision', () => {
  it('matches spaced and dashed Indian mobiles', () => {
    expect(PHONE_PATTERN.test('98765 43210')).toBe(true)
    expect(PHONE_PATTERN.test('98765-43210')).toBe(true)
    expect(PHONE_PATTERN.test('9876543210')).toBe(true)
  })

  it('does NOT match timestamps or RERA ids (no leading 6-9 at a boundary)', () => {
    expect(PHONE_PATTERN.test('built at 1727740800')).toBe(false)
    expect(PHONE_PATTERN.test('RERA 1234567890')).toBe(false)
    const ts = checkResponse('project built at 1727740800, RERA no 1234567890')
    expect(ts.violations.some((v) => v.includes('CONTACT_LEAK'))).toBe(false)
  })
})

describe('streaming guard catches unicode-evaded leaks across 3 chunk boundaries', () => {
  const phoneEvasions = [
    'call 98765 43210',
    'call 98765-43210',
    'call ९८७६५४३२१०', // Devanagari digits
    'call ૯૮૭૬૫૪૩૨૧૦', // Gujarati digits
  ]
  for (const text of phoneEvasions) {
    it(`aborts on "${text}" split across 3 chunks`, () => {
      expect(aborts(split(text, 3))).toBe(true)
    })
  }

  const secretEvasions = [
    'key: sk-proj-Ab_Cd-Ef_Gh12345678901234', // modern key with _ and - in body
    'key: sk–proj-AbCdEfGhIj1234567890KL', // en-dash prefix
    'key: sk-​proj-AbCdEfGhIj1234567890KL', // zero-width split prefix
    'key: sk_live_' + 'ABCDEFGHIJKLMNOPQRST12345', // Stripe secret key
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dozjgNryP4J3jVmNHl0w5N', // JWT
  ]
  for (const text of secretEvasions) {
    it(`aborts on secret "${text.slice(0, 18)}..." split across 3 chunks`, () => {
      expect(aborts(split(text, 3))).toBe(true)
    })
  }

  it('does not abort on prose that merely names a key', () => {
    expect(aborts(split('store your api key in a secret manager', 3))).toBe(false)
  })

  it('modern sk- key with _/- in the first 20 body chars matches directly', () => {
    expect(SECRET_LEAK_PATTERN.test('sk-Ab_Cd-Ef_Gh-Ij_Kl-Mn12')).toBe(true)
  })
})

describe('zero-width and bidi control characters', () => {
  // U+200B to U+200F, U+2060, U+FEFF, U+202A to U+202E: all in Unicode category Cf.
  const controls = [
    '\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\u2060', '\uFEFF',
    '\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
  ]

  it('normalize strips each of them from between digits', () => {
    for (const c of controls) {
      expect(normalize(`98765${c}43210`), `U+${c.codePointAt(0)?.toString(16)}`).toBe('9876543210')
    }
  })

  it('a phone number with one between every digit still trips', () => {
    const digits = '9876543210'.split('')
    const text = 'call ' + digits.map((d, i) => d + controls[i % controls.length]).join('')
    expect(aborts(split(text, 3))).toBe(true)
    expect(aborts(text.split(''))).toBe(true)
  })

  it('padding between the halves of a number neither releases the first half nor hides the match', () => {
    for (const pad of [60, 600, 5000]) {
      const g = new StreamingGuard()
      let delivered = ''
      let tripped = false
      try {
        for (const c of 'call 98765' + '\u200B'.repeat(pad) + '43210') delivered += g.onChunk(c)
        delivered += g.flush()
      } catch (e) {
        tripped = e instanceof GuardAbortError
      }
      expect(tripped, `${pad} zero-width spaces`).toBe(true)
      expect(delivered).not.toContain('98765')
    }
  })

  it('counts the hold-back in visible characters and keeps format characters in the output', () => {
    // Two zero-width spaces inside the held tail do not count toward the three
    // characters held back, so one more visible character stays behind.
    const g = new StreamingGuard({ holdback: 3 })
    expect(g.onChunk('hello wor\u200B\u200Bld')).toBe('hello wo')
    expect(g.flush()).toBe('r\u200B\u200Bld')

    const family = 'A family emoji \u{1F468}\u200D\u{1F469}\u200D\u{1F467} stays joined. ' + 'More plain words follow here. '.repeat(5)
    const h = new StreamingGuard()
    let out = ''
    for (const c of family) out += h.onChunk(c)
    out += h.flush()
    expect(out).toBe(family)
  })
})
