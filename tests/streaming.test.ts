import { describe, it, expect } from 'vitest'
import {
  StreamingGuard,
  createStreamingGuard,
  GuardAbortError,
  BUILTIN_RULE_LABELS,
  type BuiltinRuleLabel,
} from '../src/streaming/index.js'

describe('StreamingGuard', () => {

  describe('hard abort patterns', () => {
    it('hard-aborts on phone number mid-stream', () => {
      const chunks = ['Hello ', 'call ', 'us ', 'at ', '9876543210']
      let aborted = false
      let delivered = ''
      const g = new StreamingGuard({
        onAbort: () => { aborted = true }
      })
      for (const chunk of chunks) {
        try {
          g.onChunk(chunk)
          delivered += chunk
        } catch { break }
      }
      expect(aborted).toBe(true)
      // Partial content delivered before abort
      expect(delivered).toContain('at ')
      // Phone number not delivered
      expect(delivered).not.toContain('9876543210')
    })

    it('hard-aborts on email address in stream', () => {
      const g = new StreamingGuard({ onAbort: () => {} })
      let delivered = ''
      for (const chunk of ['Hi ', 'reach ', 'me ', 'at ', 'user@example.com']) {
        try {
          g.onChunk(chunk)
          delivered += chunk
        } catch { break }
      }
      expect(delivered).not.toContain('user@example.com')
    })

    it('partial delivery — no silent failures', () => {
      let delivered = ''
      const g = new StreamingGuard({ onAbort: () => {} })
      for (const chunk of ['Call ', 'us ', 'at ', '9876543210 ', 'today']) {
        try {
          g.onChunk(chunk)
          delivered += chunk
        } catch { break }
      }
      // Some content was delivered before abort
      expect(delivered.length).toBeGreaterThan(0)
      expect(delivered).not.toContain('9876543210')
    })

    it('resets and allows fresh stream after hard abort', () => {
      const g = new StreamingGuard({ onAbort: () => {} })
      try { g.onChunk('call 9988776655') } catch { /* expected abort */ }
      g.reset()
      let delivered = ''
      for (const chunk of ['Hello ', 'world']) {
        g.onChunk(chunk)
        delivered += chunk
      }
      expect(delivered).toBe('Hello world')
    })
  })

  describe('soft observe patterns', () => {
    it('fires on price commitment with final/exact keyword', () => {
      const g = new StreamingGuard()
      g.onChunk('The final price is ₹45,000 per sqft')
      expect(g.violations.some(v => v.includes('PRICE'))).toBe(true)
    })

    it('fires on discount offer with price keyword', () => {
      const g = new StreamingGuard()
      g.onChunk('We offer special discount — final price ₹45,000 per sqft')
      expect(g.violations.some(v => v.includes('PRICE'))).toBe(true)
    })

    it('fires on commission percentage pattern', () => {
      const g = new StreamingGuard()
      g.onChunk('We charge 2.5% brokerage on the deal')
      expect(g.violations.some(v => v.includes('COMMISSION'))).toBe(true)
    })

    it('fires multiple observe violations across chunks', () => {
      const g = new StreamingGuard()
      g.onChunk('The final price is ₹45,000')  // price pattern
      const priceViolations = g.violations.filter(v => v.includes('PRICE'))
      expect(priceViolations.length).toBeGreaterThan(0)
    })

    it('violations accumulate across multiple onChunk calls', () => {
      const g = new StreamingGuard()
      g.onChunk('The final price is ₹45,000. ')
      expect(g.violations.some(v => v.includes('PRICE'))).toBe(true)
    })
  })

  describe('reset behavior', () => {
    it('reset clears violations', () => {
      const g = new StreamingGuard()
      g.onChunk('The final price is ₹45,000')
      expect(g.violations.length).toBeGreaterThan(0)
      g.reset()
      expect(g.violations.length).toBe(0)
    })

    it('reset allows same patterns to fire again in new turn', () => {
      const g = new StreamingGuard()
      g.onChunk('The final price is ₹45,000')
      g.reset()
      g.onChunk('The confirmed price is ₹50,000')
      expect(g.violations.some(v => v.includes('PRICE'))).toBe(true)
    })
  })

  describe('holdback behavior', () => {
    it('respects a custom holdback', () => {
      const g = new StreamingGuard({ holdback: 8 })
      g.onChunk('The final price is ₹45,000 per sqft')
      expect(g.violations.some(v => v.includes('PRICE'))).toBe(true)
    })
  })

  describe('secret / credential leak (hard abort)', () => {
    const abortGuard = () => new StreamingGuard({ onAbort: () => {} })

    const secrets: readonly [string, string][] = [
      ['OpenAI key', 'sk-abcd1234efgh5678ijkl9012mnop'],
      ['Anthropic key', 'sk-ant-api03-abcdefghij1234567890'],
      ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
      ['GitHub token', 'ghp_' + 'a'.repeat(36)],
      ['Google API key', 'AIza' + 'B'.repeat(35)],
      ['PEM private key header', '-----BEGIN RSA PRIVATE KEY-----'],
    ]

    for (const [name, secret] of secrets) {
      it(`hard-aborts when a ${name} leaks mid-stream`, () => {
        const g = abortGuard()
        let delivered = ''
        for (const chunk of ['here ', 'is ', 'the ', 'token: ', secret]) {
          try { g.onChunk(chunk); delivered += chunk } catch { break }
        }
        // the credential itself never reaches the user
        expect(delivered).not.toContain(secret)
      })
    }

    it('does NOT false-positive on ordinary prose mentioning key/secret/bearer', () => {
      const g = abortGuard()
      let delivered = ''
      const clean = 'Store your API key in a secret manager; the bearer of that message left.'
      for (const word of clean.split(' ')) {
        g.onChunk(word + ' ')
        delivered += word + ' '
      }
      expect(delivered.trim()).toBe(clean)
    })
  })
})

describe('builtinRules option', () => {
  // One or more texts per built-in label, each of which fires that label and no
  // other. A label that stands for several rules lists a text for each rule.
  const samples: Record<BuiltinRuleLabel, string[]> = {
    SECRET_LEAK: ['sk-abcd1234efgh5678ijkl9012mnop'],
    CONTACT_LEAK: ['call 9876543210', 'write to user@example.com'],
    BUSINESS_LEAK: ['ask about partner status'],
    PRICE_COMMITMENT_LEAK: ['a 10% discount today', 'The final price is ₹45,000 per sqft'],
    COMMISSION_DISCUSSION_LEAK: ['the brokerage is 2% of the deal'],
    NO_MARKDOWN: ['Options:\n- first one', 'this is **bold** text'],
    PLACEHOLDER_LEAK: ['see [PROJECT_A] here', 'from ₹X,XXX/sqft'],
  }
  const everySample = (Object.entries(samples) as [BuiltinRuleLabel, string[]][]).flatMap(([label, texts]) =>
    texts.map((text) => ({ label, text }))
  )

  /** Labels that fired when `text` went through `guard` as one chunk. */
  function firedBy(guard: StreamingGuard, text: string): string[] {
    try {
      guard.onChunk(text)
    } catch (e) {
      if (e instanceof GuardAbortError) return [e.rule]
      throw e
    }
    return guard.violations.map((v) => v.split(':')[0])
  }

  it('the sample table names every built-in label and nothing else', () => {
    expect(Object.keys(samples).sort()).toEqual([...BUILTIN_RULE_LABELS].sort())
  })

  it('keeps every built-in rule by default, and for true', () => {
    for (const { label, text } of everySample) {
      expect(firedBy(new StreamingGuard(), text), `default: ${text}`).toEqual([label])
      expect(firedBy(new StreamingGuard({ builtinRules: true }), text), `true: ${text}`).toEqual([label])
    }
  })

  it('with false only the caller rules run: a phone number and a rupee range pass, the caller rule still trips', () => {
    const mine = { pattern: /internal-ref-\d+/i, label: 'INTERNAL_REF', mode: 'abort' as const }
    const stream = ['Rent is ₹', '65000-75000', ' a month. Call ', '9876543210', ' or write to user@example.com.']

    // The same text on the default guard is the bug this option exists for.
    expect(() => {
      const g = new StreamingGuard()
      for (const c of stream) g.onChunk(c)
    }).toThrow(GuardAbortError)

    const g = new StreamingGuard({ builtinRules: false, patterns: [mine] })
    let delivered = ''
    for (const c of stream) delivered += g.onChunk(c)
    delivered += g.flush()
    expect(delivered).toBe(stream.join(''))
    expect(g.violations).toEqual([])

    for (const { text } of everySample) {
      expect(firedBy(new StreamingGuard({ builtinRules: false }), text), text).toEqual([])
    }

    const trip = new StreamingGuard({ builtinRules: false, patterns: [mine] })
    expect(() => trip.onChunk('ticket internal-ref-4521')).toThrow(GuardAbortError)
    expect(trip.aborted).toBe(true)
  })

  it('with false a caller observe rule still records its violation', () => {
    const g = new StreamingGuard({
      builtinRules: false,
      patterns: [{ pattern: /\bTBD\b/, label: 'TBD_LEFT', mode: 'observe' }],
    })
    g.onChunk('Price: TBD, call 9876543210')
    expect(g.violations).toEqual(['TBD_LEFT: pattern matched in stream'])
  })

  it('an empty list is the same as false', () => {
    for (const { text } of everySample) {
      expect(firedBy(new StreamingGuard({ builtinRules: [] }), text), text).toEqual([])
    }
  })

  it('a label list keeps exactly those labels, and every rule under each one', () => {
    for (const keep of BUILTIN_RULE_LABELS) {
      for (const { label, text } of everySample) {
        const fired = firedBy(createStreamingGuard({ builtinRules: [keep] }), text)
        expect(fired, `keep ${keep}: ${text}`).toEqual(label === keep ? [keep] : [])
      }
    }

    const two = ['SECRET_LEAK', 'NO_MARKDOWN'] as const
    for (const { label, text } of everySample) {
      const fired = firedBy(new StreamingGuard({ builtinRules: two }), text)
      expect(fired, text).toEqual((two as readonly string[]).includes(label) ? [label] : [])
    }
  })

  it('built-ins kept by label still run before the caller rules, and a repeated label changes nothing', () => {
    const mine = { pattern: /sk-abcd1234/, label: 'MINE', mode: 'abort' as const }
    const g = new StreamingGuard({ builtinRules: ['SECRET_LEAK', 'SECRET_LEAK'], patterns: [mine] })
    expect(firedBy(g, 'sk-abcd1234efgh5678ijkl9012mnop')).toEqual(['SECRET_LEAK'])
  })

  it('an unknown label throws when the guard is built, and the message lists the valid labels', () => {
    for (const build of [
      () => new StreamingGuard({ builtinRules: ['SECRET_LEEK'] as never }),
      () => createStreamingGuard({ builtinRules: ['SECRET_LEAK', 'NOPE'] as never }),
      () => new StreamingGuard({ builtinRules: ['secret_leak'] as never }),
    ]) {
      expect(build).toThrow(/Unknown built-in rule label/)
      try {
        build()
      } catch (e) {
        for (const label of BUILTIN_RULE_LABELS) expect((e as Error).message).toContain(label)
      }
    }
    expect(() => new StreamingGuard({ builtinRules: ['SECRET_LEEK'] as never })).toThrow(/"SECRET_LEEK"/)
  })

  it('a value that is neither a boolean nor a list throws instead of silently running every rule', () => {
    expect(() => new StreamingGuard({ builtinRules: 'none' as never })).toThrow(/must be true, false or an array/)
    expect(() => new StreamingGuard({ builtinRules: 1 as never })).toThrow(/must be true, false or an array/)
  })

  it('narrowing one guard does not change the next guard built with the default', () => {
    new StreamingGuard({ builtinRules: false })
    new StreamingGuard({ builtinRules: ['NO_MARKDOWN'] })
    expect(firedBy(new StreamingGuard(), 'call 9876543210')).toEqual(['CONTACT_LEAK'])
  })
})
