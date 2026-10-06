import { describe, it, expect } from 'vitest'
import { StreamingGuard, GuardAbortError } from '../../src/streaming/index.js'

// Feed text through a fresh guard in fixed-size chunks. Returns what the guard
// delivered (including the flushed tail) or the rule that tripped.
function stream(text: string, size: number): { delivered: string; tripped?: string; violations: string[] } {
  const g = new StreamingGuard()
  let delivered = ''
  try {
    for (let i = 0; i < text.length; i += size) delivered += g.onChunk(text.slice(i, i + size))
    delivered += g.flush()
    return { delivered, violations: g.violations }
  } catch (e) {
    if (e instanceof GuardAbortError) return { delivered, tripped: e.rule, violations: g.violations }
    throw e
  }
}

// The scan window starts 512 characters before each new chunk. Where that edge
// cuts into a word, the cut-off end used to be read as the start of a string,
// so lookbehinds and anchors saw nothing before it.
describe('scan window edge', () => {
  it('does not read the end of a clean hyphenated word as an sk- key', () => {
    const text = 'We ran a risk-adjusted-return-on-capital review. ' + 'The team agreed on the next steps. '.repeat(20)
    for (const size of [1, 2, 3]) {
      const out = stream(text, size)
      expect(out.tripped, `chunk size ${size}`).toBeUndefined()
      expect(out.delivered).toBe(text)
    }
  })

  it('does not read the last ten digits of a 15-digit id as a phone number', () => {
    const text =
      "Your order's reference is 123457890123456 and it ships today. " +
      'The courier will update the tracking page soon. '.repeat(20)
    for (const size of [1, 2, 3, 4]) {
      const out = stream(text, size)
      expect(out.tripped, `chunk size ${size}`).toBeUndefined()
      expect(out.delivered).toBe(text)
    }
  })

  it('does not read a # inside a line as a markdown header', () => {
    const text =
      'Most of the service is written in C# and some of it in F#. ' +
      'The build runs on every push to the main branch. '.repeat(20)
    expect(stream(text, 1).violations).toEqual([])
  })

  it('still catches a phone number that straddles the window edge region', () => {
    const text = 'The team agreed on the next steps. '.repeat(20) + 'call 9876543210 today'
    for (const size of [1, 3, 7]) {
      const out = stream(text, size)
      expect(out.tripped, `chunk size ${size}`).toBe('CONTACT_LEAK')
      expect(out.delivered).not.toContain('98765')
    }
  })
})
