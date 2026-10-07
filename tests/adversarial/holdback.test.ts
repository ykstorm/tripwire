import { describe, it, expect, vi } from 'vitest'
import { StreamingGuard, GuardAbortError } from '../../src/streaming/index.js'

// Drive a guard through chunks, collecting everything it releases. Returns the
// delivered text and whether it aborted.
function drive(chunks: string[], holdback: number): { delivered: string; aborted: boolean } {
  const g = new StreamingGuard({ holdback })
  let delivered = ''
  try {
    for (const c of chunks) delivered += g.onChunk(c)
    delivered += g.flush()
    return { delivered, aborted: false }
  } catch (e) {
    if (e instanceof GuardAbortError) return { delivered, aborted: true }
    throw e
  }
}

describe('hold-back buffer (cross-chunk leak prevention)', () => {
  it('a phone split across chunks delivers the safe prefix but never the number', () => {
    const { delivered, aborted } = drive(['call ', '98765', '43210'], 5)
    expect(aborted).toBe(true)
    expect(delivered).toBe('call ')
    expect(delivered).not.toContain('98765')
    expect(delivered).not.toContain('43210')
  })

  it('a secret split across chunks never releases the sk- prefix', () => {
    const { delivered, aborted } = drive(
      ['key: ', 'sk-proj-AbCdEfGhIj', 'KlMnOpQrStUv123456'],
      48
    )
    expect(aborted).toBe(true)
    expect(delivered).not.toContain('sk-')
  })

  it('releases content lagging by the hold-back and flushes the tail', () => {
    const g = new StreamingGuard({ holdback: 3 })
    let out = ''
    out += g.onChunk('hello world') // 11 chars, release all but last 3
    expect(out).toBe('hello wo')
    out += g.flush()
    expect(out).toBe('hello world')
  })

  it('a non-throwing onAbort still throws GuardAbortError', () => {
    const onAbort = vi.fn()
    const g = new StreamingGuard({ onAbort, holdback: 4 })
    expect(() => g.onChunk('call 9876543210')).toThrow(GuardAbortError)
    expect(onAbort).toHaveBeenCalledOnce()
  })

  it('a throwing onAbort still ends in GuardAbortError, and its error is logged', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const g = new StreamingGuard({
        holdback: 4,
        onAbort: () => {
          throw new Error('handler bug')
        },
      })
      let caught: unknown
      try {
        g.onChunk('call 9876543210')
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(GuardAbortError)
      expect((caught as GuardAbortError).rule).toBe('CONTACT_LEAK')
      expect(g.aborted).toBe(true)
      expect(logged).toHaveBeenCalledOnce()
      expect(String(logged.mock.calls[0][1])).toContain('handler bug')
    } finally {
      logged.mockRestore()
    }
  })

  it('a chunk after abort throws without re-matching (latched)', () => {
    const g = new StreamingGuard({ holdback: 4 })
    expect(() => g.onChunk('call 9876543210')).toThrow(GuardAbortError)
    // Clean content would normally pass; the latch throws anyway.
    expect(() => g.onChunk('perfectly safe text')).toThrow(GuardAbortError)
  })

  it('flush returns nothing once aborted (held tail may precede the leak)', () => {
    const g = new StreamingGuard({ holdback: 4 })
    try {
      g.onChunk('call 9876543210')
    } catch {
      /* expected */
    }
    expect(g.flush()).toBe('')
    expect(g.aborted).toBe(true)
  })

  it('reset clears the latch and allows a fresh stream', () => {
    const g = new StreamingGuard({ holdback: 2 })
    try {
      g.onChunk('call 9876543210')
    } catch {
      /* expected */
    }
    g.reset()
    expect(g.aborted).toBe(false)
    let out = ''
    out += g.onChunk('all good')
    out += g.flush()
    expect(out).toBe('all good')
  })
})

describe('hold-back with the built-in rules off', () => {
  // The hold-back is its own option. It is not worked out from the rules that
  // run, so turning the built-ins off neither shortens nor lengthens it.
  const chunks = ['The flat is ', 'on the third floor ', 'of a quiet building ', 'near the metro station, ', 'with parking.']

  function releasedPerChunk(options: ConstructorParameters<typeof StreamingGuard>[0]): string[] {
    const g = new StreamingGuard(options)
    return [...chunks.map((c) => g.onChunk(c)), g.flush()]
  }

  it('releases exactly what the default guard releases, chunk by chunk, at the default and at a custom hold-back', () => {
    for (const holdback of [undefined, 7]) {
      expect(releasedPerChunk({ builtinRules: false, holdback })).toEqual(releasedPerChunk({ holdback }))
    }
  })

  it('still withholds the last 48 characters by default and hands them back on flush', () => {
    const g = new StreamingGuard({ builtinRules: false })
    const out = g.onChunk('x'.repeat(100))
    expect(out).toHaveLength(52)
    expect(g.flush()).toHaveLength(48)
  })

  it('keeps a caller rule split across chunks from releasing its first half when the hold-back covers the match', () => {
    const rule = { pattern: /launch-codes/i, label: 'LAUNCH', mode: 'abort' as const }
    // "launch-codes" is 12 characters, so 11 of them can arrive before the match completes.
    const g = new StreamingGuard({ builtinRules: false, patterns: [rule], holdback: 11 })
    let delivered = ''
    let caught: unknown
    try {
      for (const c of ['say ', 'launch-', 'codes']) delivered += g.onChunk(c)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(GuardAbortError)
    expect((caught as GuardAbortError).rule).toBe('LAUNCH')
    expect(delivered).toBe('')
    expect(g.flush()).toBe('')
  })
})
