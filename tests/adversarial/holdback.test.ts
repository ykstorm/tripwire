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
