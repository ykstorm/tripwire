// Streaming guard — real-time pattern detection during LLM token stream.
//
// Usage:
//   const guard = createStreamingGuard({ onAbort, onViolate })
//   for (const token of stream) {
//     guard.onChunk(token)  // throws if a hard-abort pattern fires
//     yield token
//   }

import {
  CONTACT_LEAK_PATTERN,
  BUSINESS_LEAK_PATTERN,
  MARKDOWN_PATTERN,
  PLACEHOLDER_NAME_PATTERN,
  PLACEHOLDER_PRICE_PATTERN,
  PLACEHOLDER_CUID_PATTERN,
  PRICE_DISCOUNT_COMMIT_PATTERN,
  PRICE_FINAL_COMMIT_PATTERN,
  COMMISSION_PATTERN,
} from '../patterns/index.js'

export type ViolationHandler = (violation: string, pattern: string) => void
export type AbortHandler = (violation: string, pattern: string) => never

export interface StreamingGuardOptions {
  /** Called (non-blocking) when a soft-observe pattern fires. Default: no-op. */
  onViolate?: ViolationHandler
  /** Called when a hard-abort pattern fires — should throw. Default: throws. */
  onAbort?: AbortHandler
  /**
   * Token window size for partial-pattern matching across chunk boundaries.
   * The guard accumulates up to `windowSize` tokens of text before running
   * multi-token patterns. Default: 16.
   */
  windowSize?: number
}

interface PatternEntry {
  pattern: RegExp
  label: string
  mode: 'abort' | 'observe'
}

const DEFAULT_ABORT: AbortHandler = (msg) => { throw new Error(`[GUARD_ABORT] ${msg}`) }

export class StreamingGuard {
  private accumulated: string = ''
  private readonly windowSize: number
  private readonly patterns: PatternEntry[]
  private readonly onViolate: ViolationHandler
  private readonly onAbort: AbortHandler
  readonly violations: string[] = []

  constructor(options: StreamingGuardOptions = {}) {
    this.windowSize = options.windowSize ?? 16
    this.onViolate = options.onViolate ?? (() => {})
    this.onAbort = options.onAbort ?? DEFAULT_ABORT

    // All streaming patterns — order matters for abort priority
    this.patterns = [
      // Safety — hard abort
      { pattern: CONTACT_LEAK_PATTERN, label: 'CONTACT_LEAK', mode: 'abort' },
      { pattern: BUSINESS_LEAK_PATTERN, label: 'BUSINESS_LEAK', mode: 'abort' },
      // Content quality — soft observe (LOCKS-1 observe-only per brief)
      { pattern: PRICE_DISCOUNT_COMMIT_PATTERN, label: 'PRICE_COMMITMENT_LEAK', mode: 'observe' },
      { pattern: PRICE_FINAL_COMMIT_PATTERN, label: 'PRICE_COMMITMENT_LEAK', mode: 'observe' },
      { pattern: COMMISSION_PATTERN, label: 'COMMISSION_DISCUSSION_LEAK', mode: 'observe' },
      // Markdown — soft observe (not safety-critical, does not block stream)
      { pattern: MARKDOWN_PATTERN, label: 'NO_MARKDOWN', mode: 'observe' },
      // Placeholder leaks — soft observe
      { pattern: PLACEHOLDER_NAME_PATTERN, label: 'PLACEHOLDER_LEAK', mode: 'observe' },
      { pattern: PLACEHOLDER_PRICE_PATTERN, label: 'PLACEHOLDER_LEAK', mode: 'observe' },
      { pattern: PLACEHOLDER_CUID_PATTERN, label: 'PLACEHOLDER_LEAK', mode: 'observe' },
    ]
  }

  /** Process a token chunk. Throws if any abort pattern fires. */
  onChunk(chunk: string): void {
    this.accumulated += chunk

    // Keep the accumulation window bounded to windowSize tokens (rough word-based)
    // For regex partial matching we keep the full accumulated string since
    // multiline patterns need full context; a sliding window is handled by
    // the consumer resetting if needed.
    if (this.accumulated.length > this.windowSize * 50) {
      // rough: ~50 chars/token, trim to last windowSize tokens
      this.accumulated = this.accumulated.slice(-this.windowSize * 50)
    }

    for (const { pattern, label, mode } of this.patterns) {
      // Reset lastIndex to avoid stale regex state
      pattern.lastIndex = 0
      if (pattern.test(this.accumulated)) {
        pattern.lastIndex = 0
        if (mode === 'abort') {
          this.onAbort(`${label}: pattern matched in stream`, label)
        } else {
          this.violations.push(`${label}: pattern matched in stream`)
          this.onViolate(`${label}: pattern matched in stream`, label)
        }
      }
    }
  }

  /** Clear accumulated buffer and violations (for new conversation turn). */
  reset(): void {
    this.accumulated = ''
    this.violations.length = 0
  }
}

/**
 * Factory to create a StreamingGuard with optional custom pattern list.
 * Custom patterns override defaults if they share the same label.
 */
export function createStreamingGuard(
  handlers: { onViolate?: ViolationHandler; onAbort?: AbortHandler } = {},
  _customPatterns?: Array<{ pattern: RegExp; label: string; mode: 'abort' | 'observe' }>
): StreamingGuard {
  void _customPatterns // TODO: wire custom patterns into StreamingGuard
  return new StreamingGuard({
    onViolate: handlers.onViolate,
    onAbort: handlers.onAbort,
  })
}