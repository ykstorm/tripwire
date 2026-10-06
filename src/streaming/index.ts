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

import { normalize, FORMAT_CHARS } from '../normalize.js'
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

/** Characters of earlier text scanned with each new chunk, so a match that
 *  straddles chunks is caught when its last character arrives. A rule only sees
 *  a match that fits inside this overlap plus the new chunk. Every fixed-length
 *  built-in shape is far shorter (the longest, a GitHub token, is 40
 *  characters), but the JWT rule has no upper bound: a token whose header and
 *  payload together run past about 512 characters is never seen whole, so it is
 *  not caught. */
const SCAN_OVERLAP = 512

/** Characters before the overlap that the rules can look back at but cannot
 *  start a match in. Without them a lookbehind, `\b` or a multiline `^` at the
 *  window's first character sees the start of a string, so the cut-off end of a
 *  clean word (`sk-adjusted...` out of `risk-adjusted...`) or of a long number
 *  could match. */
const EDGE_CONTEXT = 64

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
  /** The rule as given, recompiled with only the g flag added: test() then
   *  starts at lastIndex while lookbehinds still see the text before it. A g
   *  or y flag on the caller's regex is dropped, so its own lastIndex never
   *  matters. */
  scanner: RegExp
  label: string
  mode: 'abort' | 'observe'
}

function entry({ pattern, label, mode }: CustomPattern): PatternEntry {
  return { scanner: new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g'), label, mode }
}

/** Normalization only changes non-ASCII text, so pure ASCII skips it. */
function prepare(text: string): string {
  return NON_ASCII.test(text) ? normalize(text) : text
}

export class StreamingGuard {
  private raw = ''
  private releasedLen = 0
  /** Already-scanned text with format characters removed: at most
   *  EDGE_CONTEXT + SCAN_OVERLAP characters. */
  private recent = ''
  /** Raw index of every format code unit (zero-width spaces and the like). */
  private readonly formatAt: number[] = []
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

    const builtIn: CustomPattern[] = [
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
    // Custom patterns run after the built-ins, so a built-in abort wins on the same chunk.
    this.patterns = [...builtIn, ...(options.patterns ?? [])].map(entry)
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
    const visible = this.stripFormat(chunk)
    this.raw += chunk
    if (visible) this.runPatterns(visible)
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
    this.recent = ''
    this.formatAt.length = 0
    this.abortedFlag = false
    this.abortRule = 'ABORTED'
    this.violations.length = 0
    this.firedObserve.clear()
  }

  /**
   * The chunk without format characters (the ones normalize() deletes),
   * recording where each one sits in the raw stream. The rules never see them,
   * so the scan window and the hold-back do not count them either: padding a
   * number with hundreds of zero-width spaces cannot push its first half out
   * or its start out of the window.
   */
  private stripFormat(chunk: string): string {
    if (!NON_ASCII.test(chunk)) return chunk
    const base = this.raw.length
    for (const m of chunk.matchAll(FORMAT_CHARS)) {
      for (let k = 0; k < m[0].length; k++) this.formatAt.push(base + (m.index ?? 0) + k)
    }
    return chunk.replace(FORMAT_CHARS, '')
  }

  private runPatterns(visible: string): void {
    // Scan the new text plus SCAN_OVERLAP characters before it. The
    // EDGE_CONTEXT characters before that are only there for lookbehinds and
    // anchors: matching starts after them (lastIndex), so a match cannot begin
    // in text that earlier windows already covered.
    const contextLen = Math.max(0, this.recent.length - SCAN_OVERLAP)
    const context = prepare(this.recent.slice(0, contextLen))
    const text = context + prepare(this.recent.slice(contextLen) + visible)
    this.recent = (this.recent + visible).slice(-(EDGE_CONTEXT + SCAN_OVERLAP))
    for (const { scanner, label, mode } of this.patterns) {
      scanner.lastIndex = context.length
      if (!scanner.test(text)) continue
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

  /** Everything except the last `holdback` visible characters, from where the
   *  previous release stopped. */
  private releasable(): string {
    const visibleLen = this.raw.length - this.formatAt.length
    const keep = this.rawIndexOfVisible(visibleLen - this.holdback)
    if (keep <= this.releasedLen) return ''
    const out = this.raw.slice(this.releasedLen, keep)
    this.releasedLen = keep
    return out
  }

  /** Raw index of visible code unit `n` (raw.length when n counts them all);
   *  just n when the stream has no format characters. */
  private rawIndexOfVisible(n: number): number {
    const at = this.formatAt
    if (at.length === 0 || n < 0) return n
    // at[k] - k is the number of visible units before format unit k; count the
    // format units that come before visible unit n.
    let lo = 0
    let hi = at.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (at[mid] - mid <= n) lo = mid + 1
      else hi = mid
    }
    return n + lo
  }
}

/** Factory for a StreamingGuard. */
export function createStreamingGuard(options: StreamingGuardOptions = {}): StreamingGuard {
  return new StreamingGuard(options)
}
