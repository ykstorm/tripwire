# RFC-2 — Mid-Stream LLM Guardrails

**RFC:** 2 · **Title:** Mid-stream LLM guardrails · **Author:** Lakshyaraj Singh Rao · **Status:** shipped in `@ykstormsorg/tripwire` v1.1.0 · **Date:** 2026-07-18

## Summary

Streaming LLM responses commit tokens to the consumer as they generate; a violation in the stream is delivered before any completion-time check can see it. This RFC specifies a guard that inspects the accumulated token stream per chunk and aborts on a hard-policy match before the offending token is yielded, at approximately 4.7 microseconds per chunk measured in CI. Severity is two-tiered: hard-abort for irreversible harms, observe-only for drift, with promotion from observe to abort gated on measured precision. On abort, the consumer keeps the partial delivered plus a structured error, never a blank. A post-hoc batch mode shares the pattern set for completed-text audits. The implementation is Tripwire (`github.com/ykstorm/tripwire`, `@ykstormsorg/tripwire`).

## Motivation

In a production consumer chat, a streamed response emitted an unfilled template placeholder — the literal `{{PRICE}}` — into a buyer's message. A completion-time content check existed and would have caught it, but it ran in the `onFinish` handler, after the full response had already streamed to the screen. The buyer had read the placeholder before the check fired. The check produced a Sentry event and no remedy.

The failure class is every streamed generation: once a token is yielded to the consumer it is on their screen and cannot be retracted, so any check that runs after the stream completes is an audit, not a guard. The harms are concrete — a fabricated entity name, a leaked contact detail, a committed discount, a placeholder variable — and they share the property that delivery is the harm. A guard that prevents them must run before the token is yielded, which means inside the stream, per chunk. The cost objection (a check on every token in a latency path) is the reason most systems do not do this; measuring the cost dissolves the objection.

## Design goals

**G1 — Catch violations before delivery.** The check runs per chunk on the accumulated buffer and can abort before the offending token is yielded. *Non-goal:* catching violations that require the completed response to detect — those belong to the batch mode, which accepts post-delivery latency.

**G2 — Match across chunk boundaries.** The matcher runs on accumulated text, not the incoming delta, so a violation split across two chunks is still caught. *Non-goal:* unbounded accumulation — the buffer is windowed to keep per-chunk cost flat regardless of response length.

**G3 — Two-tier severity.** Hard-abort patterns throw; observe patterns log and continue. *Non-goal:* a single uniform severity — treating every pattern as hard-abort would kill good streams on soft signals, and treating every pattern as observe would deliver the irreversible harms.

**G4 — Negligible latency cost.** Per-chunk overhead must be small against the inter-token gap. Measured ~4.7µs per chunk versus ~15ms provider inter-token time, roughly three orders of magnitude of headroom. *Non-goal:* zero cost — the check is not free, only negligible, and the design spends that cost deliberately.

**G5 — Coherent abort.** On abort the consumer retains the delivered partial plus a structured error; the application swaps a safe fallback. *Non-goal:* silent suppression of the whole response — blanking punishes the clean majority and reads as the machine erasing itself.

## Design

**Mechanism.** `StreamingGuard` wraps the token stream. `onChunk(chunk)` appends to an accumulated buffer and evaluates the pattern list against the buffer on every call (`src/streaming/index.ts:108`). Each pattern carries a mode — abort or observe (`:64`). On an abort match, the guard throws immediately (`:126`), before the token propagates; on an observe match, it pushes a violation and continues (`:128`). The buffer is trimmed to a window so the match cost does not grow with response length (`:117`).

**Data model.** A pattern is a compiled regex plus a label plus a mode (`abort | observe`). Default patterns cover contact-info leaks and business-sensitive leaks — commission rates and partner-status claims (`src/patterns/business.ts`) — as abort; placeholders, markdown artifacts, and price-commitment language as observe. Callers extend or override via a factory (`createStreamingGuard`). The guard holds the accumulated buffer, the pattern list, an `onViolate` handler, and an `onAbort` handler.

**Invariants.** (1) An abort throws before the matched content is yielded onward. (2) The accumulated buffer, not the delta, is the match target, so boundary-straddling violations are caught. (3) Per-chunk cost is bounded by the window, independent of total length. (4) An observe match never blocks the stream; it only records.

**Failure modes covered.** Irreversible leaks reaching the user — covered by abort-before-yield (G1). Boundary-split violations — covered by accumulated-buffer matching (G2). False-positive stream kills on soft signals — covered by the observe tier (G3). Latency regression — the CI benchmark publishes the per-chunk cost so a regression is caught (G4). Incoherent aborts — covered by partial-plus-fallback (G5).

**Failure modes NOT covered.** Semantic violations no regex can express — a fabrication that matches no pattern passes; the guard catches mechanical violations, and semantic drift belongs to the eval layer (RFC-adjacent, Goldset) and the post-hoc judge, not the stream. Violations detectable only from the completed response — deferred to the batch `checkResponse` mode (`src/check.ts`), which accepts post-delivery timing. A pattern list that is wrong — the guard enforces the patterns it is given; correctness of the pattern set is the operator's responsibility, mitigated by the observe tier as a staging ground.

## Alternatives considered

**A1 — Post-hoc check on the completed response.** Run all patterns in `onFinish`. Rejected because by the time the response is complete the tokens have been delivered; the check becomes an audit that documents the harm rather than a guard that prevents it. It remains useful as a batch mode for non-streamed or after-the-fact review, which is why it ships as `checkResponse`, but it cannot be the primary guard for streamed output.

**A2 — Per-chunk LLM judge.** Ask a second model to evaluate each chunk for policy compliance. Rejected on latency: a model call per chunk multiplies time-to-last-token by orders of magnitude, turning a negligible-cost guard into the dominant cost of the response. The regex tier catches the mechanical violation classes where precision is high; semantic judgment belongs to a layer that can afford model latency, which the per-token path cannot.

**A3 — Uniform hard-abort on any match.** Treat every pattern as abort; no observe tier. Rejected because it destroys good responses on soft signals — a price-commitment phrase or a markdown artifact is not worth killing a stream the user is reading, and a guard that frequently kills good streams is a guard the product disables. The two-tier split is what makes aggressive pattern coverage shippable: you can add a pattern in observe mode, measure its precision, and promote it only when the data justifies the abort authority.

## Prior art

**OpenAI moderation endpoint** — a separate classification call on input or output; Tripwire runs inline and per-chunk rather than as a discrete pre/post call, trading semantic reach for the ability to abort mid-stream. **NeMo Guardrails** — a policy framework with programmable rails; Tripwire is narrower and lighter, a per-chunk regex guard rather than a dialogue-management layer, aimed at the abort-before-delivery property specifically. **Content-Security-Policy in browsers** — the closest structural analog: a policy enforced at the delivery boundary rather than trusted to the source; Tripwire applies the same enforce-at-the-boundary stance to token streams.

## Open questions

**Q1 — Partial-delivery contract.** On abort, is the canonical consumer behavior to keep the partial and render an error part, or to replace the message? The tradeoff: partial-plus-error preserves conversation coherence but shows content the model started and stopped; replacement is cleaner but discards clean tokens the user read. The shape of the answer is likely per-application, with the SDK integration exposing both.

**Q2 — Observe-to-abort promotion criteria.** What false-positive rate justifies promoting a pattern from observe to abort? The tradeoff is a threshold: too strict and useful patterns never earn abort authority; too loose and a noisy pattern kills good streams. The answer is a measured precision floor, corpus-specific.

**Q3 — Window size versus boundary reach.** The buffer trim bounds cost but also bounds how far back a boundary-straddling match can reach. What window keeps cost flat without missing long-span violations? Tradeoff: larger window catches longer violations at higher per-chunk cost.

**Q4 — Multi-tenant pattern isolation.** Patterns are global to a guard instance. For a multi-tenant proxy, should patterns be per-tenant, and at what cost to the shared compiled-regex efficiency? Tradeoff: per-tenant flexibility against shared-compilation speed.

**Q5 — Interaction with tool-call streams.** Structured tool-call deltas are not prose; do prose patterns misfire on them, and should the guard mode-switch on content type? Tradeoff: content-type awareness adds complexity but prevents false matches on structured output.

## Rollout

Introduce the guard in observe-only mode first: wrap the existing stream, run the full pattern set, log every match, abort nothing. Collect the false-positive rate per pattern from the observe logs over real traffic. Promote patterns to abort individually, in order of measured precision, starting with the irreversible-harm classes (contact leaks, business-sensitive leaks) whose cost of a miss is highest. Ship the partial-plus-fallback handling in the application layer before enabling any abort, so the first abort has a coherent consumer experience. Deploy as a library wrap for in-process use or as the OpenAI-compatible sidecar for cross-service use; the sidecar aborts mid-stream and emits a structured SSE error part on a rule trip. Monitor per-pattern fire rates, abort rates, and the CI-published per-chunk cost; a rise in a pattern's fire rate is either drift to investigate or a false-positive spike to demote. The benchmark workflow runs on push so the ~4.7µs cost is a regression-gated number, not a one-time measurement.
