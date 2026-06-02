import { describe, it, expect } from 'vitest'
import { StreamingGuard } from '../src/streaming/index.js'

describe('StreamingGuard', () => {

  describe('hard abort patterns', () => {
    it('hard-aborts on phone number mid-stream', () => {
      const chunks = ['Hello ', 'call ', 'us ', 'at ', '9876543210']
      let aborted = false
      let delivered = ''
      const g = new StreamingGuard({
        onAbort: () => { aborted = true; throw new Error('ABORT') }
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
      const g = new StreamingGuard({ onAbort: () => { throw new Error('ABORT') } })
      let delivered = ''
      for (const chunk of ['Hi ', 'reach ', 'me ', 'at ', 'balvir@homesty.ai']) {
        try {
          g.onChunk(chunk)
          delivered += chunk
        } catch { break }
      }
      expect(delivered).not.toContain('balvir@homesty.ai')
    })

    it('partial delivery — no silent failures', () => {
      let delivered = ''
      const g = new StreamingGuard({ onAbort: () => { throw new Error('ABORT') } })
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
      const g = new StreamingGuard({ onAbort: () => { throw new Error('ABORT') } })
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

  describe('windowSize behavior', () => {
    it('respects custom windowSize', () => {
      const g = new StreamingGuard({ windowSize: 32 })
      g.onChunk('The final price is ₹45,000 per sqft')
      expect(g.violations.some(v => v.includes('PRICE'))).toBe(true)
    })
  })
})