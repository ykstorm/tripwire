// Streaming guard - real-time pattern detection during an LLM token stream.
//
// The core guarantee is the hold-back buffer. A violation can straddle a chunk
// boundary ("call " + "98765" + "43210"): if the guard released each chunk as it
// arrived, the safe-looking prefix would reach the user before the full pattern
// was visible. Instead the guard holds back the last `holdback` characters of the
// raw stream, matches the normalized buffer on every chunk, and only releases
// text once enough following context has arrived to rule out a straddling match.
//
// Usage:
//   const guard = createStreamingGuard({ onViolate })
//   for await (const token of stream) {
//     send(guard.onChunk(token))   // forward only what the guard releases
//   }
//   send(guard.flush())            // release the held-back tail at the end
//
// onChunk throws GuardAbortError the instant a hard-abort pattern matches; the
// guard latches aborted and every later onChunk throws until reset().

import { normalize } from '../normalize.js'
import {
  CONTACT_LEAK_PATTERN,
  SECRET_LEAK_PATTERN,
  BUSINESS_LEAK_PATTERN,
  MARKDOWN_PATTERN,
  PLACEHOLDER_NAME_PATTERN,
  PLACEHOLDER_PRICE_PATTERN,
  PLACEHOLDER_CUID_PATTERN,
  PRICE_DISCOUNT_COMMIT_PATTERN,
  PRICE_FINAL_COMMIT_PATTERN,
  COMMISSION_PATTERN,
} from '../patterns/index.js'

/** Default number of trailing characters withheld until later context arrives. */
export const DEFAULT_HOLDBACK = 48

/** A single onChunk delta larger than this is rejected (see ChunkTooLargeError). */
export const MAX_CHUNK_CHARS = 16384

/** Characters of prior context scanned alongside each new chunk. Comfortably
 *  larger than any built-in pattern's span, so a straddling match is caught the
 *  moment its final character arrives without re-scanning the whole buffer. */
const SCAN_OVERLAP = 512

/** Fast path: normalization only changes non-ASCII text (code unit >= 0x80,
 *  which also covers astral characters via their surrogate halves). */
const NON_ASCII = /\P{ASCII}/u

/** Thrown by onChunk when a hard-abort pattern matches. Always thrown on abort,
 *  even when a caller-supplied onAbort handler does not throw. */
export class GuardAbortError extends Error {
  readonly rule: string
  constructor(violation: string, rule: string) {
    super(violation)
    this.name = 'GuardAbortError'
    this.rule = rule
  }
}

/** Thrown by onChunk when a single delta exceeds MAX_CHUNK_CHARS. */
export class ChunkTooLargeError extends Error {
  constructor(size: number) {
    super(`CHUNK_TOO_LARGE: chunk of ${size} chars exceeds ${MAX_CHUNK_CHARS}`)
    this.name = 'ChunkTooLargeError'
  }
}

/** Soft-observe handler - called when an observe pattern fires. */
export type ViolationHandler = (violation: string, pattern: string) => void
/** Hard-abort handler - called when an abort pattern fires. May throw; the guard
 *  throws GuardAbortError afterwards regardless. */
export type AbortHandler = (violation: string, pattern: string) => void

/** A user-supplied custom pattern entry. */
export interface CustomPattern {
  pattern: RegExp
  label: string
  mode: 'abort' | 'observe'
}

export interface StreamingGuardOptions {
  /** Called when a soft-observe pattern fires. Default: no-op. */
  onViolate?: ViolationHandler
  /** Called when a hard-abort pattern fires. Default: no-op (GuardAbortError is
   *  always thrown by the guard itself). */
  onAbort?: AbortHandler
  /** Custom patterns MERGED after the built-ins, so a built-in abort still wins
   *  on the same chunk but every custom pattern genuinely fires. */
  patterns?: CustomPattern[]
  /** Characters held back until following context arrives. Default DEFAULT_HOLDBACK. */
  holdback?: number
}

interface PatternEntry {
  pattern: RegExp
  label: string
  mode: 'abort' | 'observe'
}

export class StreamingGuard {
  private raw = ''
  private releasedLen = 0
  private abortedFlag = false
  private abortRule = 'ABORTED'
  private readonly firedObserve = new Set<string>()
  private readonly holdback: number
  private readonly patterns: PatternEntry[]
  private readonly onViolate: ViolationHandler
  private readonly onAbort: AbortHandler
  readonly violations: string[] = []

  constructor(options: StreamingGuardOptions = {}) {
    this.holdback = Math.max(0, options.holdback ?? DEFAULT_HOLDBACK)
    this.onViolate = options.onViolate ?? (() => {})
    this.onAbort = options.onAbort ?? (() => {})

    this.patterns = [
      // Safety - hard abort.
      { pattern: SECRET_LEAK_PATTERN, label: 'SECRET_LEAK', mode: 'abort' },
      { pattern: CONTACT_LEAK_PATTERN, label: 'CONTACT_LEAK', mode: 'abort' },
      { pattern: BUSINESS_LEAK_PATTERN, label: 'BUSINESS_LEAK', mode: 'abort' },
      // Content quality - soft observe.
      { pattern: PRICE_DISCOUNT_COMMIT_PATTERN, label: 'PRICE_COMMITMENT_LEAK', mode: 'observe' },
      { pattern: PRICE_FINAL_COMMIT_PATTERN, label: 'PRICE_COMMITMENT_LEAK', mode: 'observe' },
      { pattern: COMMISSION_PATTERN, label: 'COMMISSION_DISCUSSION_LEAK', mode: 'observe' },
      { pattern: MARKDOWN_PATTERN, label: 'NO_MARKDOWN', mode: 'observe' },
      { pattern: PLACEHOLDER_NAME_PATTERN, label: 'PLACEHOLDER_LEAK', mode: 'observe' },
      { pattern: PLACEHOLDER_PRICE_PATTERN, label: 'PLACEHOLDER_LEAK', mode: 'observe' },
      { pattern: PLACEHOLDER_CUID_PATTERN, label: 'PLACEHOLDER_LEAK', mode: 'observe' },
    ]

    if (options.patterns?.length) {
      this.patterns.push(...options.patterns)
    }
  }

  /** Whether a hard-abort pattern has latched this guard. */
  get aborted(): boolean {
    return this.abortedFlag
  }

  /**
   * Process a chunk. Appends it to the raw buffer, matches the normalized
   * buffer, and returns the text that is now safe to release (everything except
   * the held-back tail). Throws GuardAbortError on a hard-abort match or if the
   * guard is already aborted.
   */
  onChunk(chunk: string): string {
    if (this.abortedFlag) {
      throw new GuardAbortError('stream already aborted', this.abortRule)
    }
    if (chunk.length > MAX_CHUNK_CHARS) {
      throw new ChunkTooLargeError(chunk.length)
    }
    this.raw += chunk
    this.runPatterns(chunk.length)
    return this.releasable()
  }

  /** Release the held-back tail. Returns '' once aborted (held text may precede
   *  the violation and must never be delivered). Call before the stream closes. */
  flush(): string {
    if (this.abortedFlag) return ''
    const out = this.raw.slice(this.releasedLen)
    this.releasedLen = this.raw.length
    return out
  }

  /** Clear buffers, violations, and the abort latch for a new turn. */
  reset(): void {
    this.raw = ''
    this.releasedLen = 0
    this.abortedFlag = false
    this.abortRule = 'ABORTED'
    this.violations.length = 0
    this.firedObserve.clear()
  }

  private runPatterns(chunkLen: number): void {
    // Scan only the new chunk plus enough prior context to catch a straddling
    // match; normalize only when the window actually holds non-ASCII text.
    const start = Math.max(0, this.raw.length - chunkLen - SCAN_OVERLAP)
    const window = this.raw.slice(start)
    const text = NON_ASCII.test(window) ? normalize(window) : window
    for (const { pattern, label, mode } of this.patterns) {
      if (!pattern.test(text)) continue
      const violation = `${label}: pattern matched in stream`
      if (mode === 'abort') {
        this.abortedFlag = true
        this.abortRule = label
        this.onAbort(violation, label)
        throw new GuardAbortError(violation, label)
      }
      if (!this.firedObserve.has(label)) {
        this.firedObserve.add(label)
        this.violations.push(violation)
        this.onViolate(violation, label)
      }
    }
  }

  private releasable(): string {
    const keep = Math.max(this.releasedLen, this.raw.length - this.holdback)
    if (keep <= this.releasedLen) return ''
    const out = this.raw.slice(this.releasedLen, keep)
    this.releasedLen = keep
    return out
  }
}

/** Factory for a StreamingGuard. */
export function createStreamingGuard(options: StreamingGuardOptions = {}): StreamingGuard {
  return new StreamingGuard(options)
}
