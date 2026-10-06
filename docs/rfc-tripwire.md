# RFC 2: Mid-stream LLM guardrails

RFC 2. Title: Mid-stream LLM guardrails. Author: Lakshyaraj Singh Rao. Status: implemented on `main`, not yet released (npm 1.1.0, published 2026-06-23, predates the hold-back design, which is explained under Design). Date: 2026-07-18.

## Summary

A streaming LLM response commits tokens to the consumer as they are generated. A violation in the stream is delivered before any completion-time check can see it.

This RFC specifies a guard that inspects the accumulated token stream on every chunk. A chunk is one piece of the stream as it arrives. On a hard-policy match, the guard aborts before the offending token is yielded, meaning handed on to the consumer. The cost per chunk is small next to the provider's inter-token latency, which is the time between one token and the next. The committed benchmark baseline in `bench/results.txt` is the regression-gated number. Regression-gated means the benchmark workflow fails if the cost rises past 3x that baseline.

Severity has two tiers. Hard-abort is for irreversible harms. Observe-only is for drift. A pattern moves from observe to abort only when measured precision justifies it. On abort, the consumer keeps the partial text already delivered, plus a structured error. It never gets a blank.

A post-hoc batch mode shares the pattern set and audits completed text. Post-hoc means after the response is complete. The implementation is Tripwire (`github.com/ykstorm/tripwire`, `@ykstormsorg/tripwire`).

## Motivation

In a production consumer chat, a streamed response put an unfilled price placeholder into a buyer's message. The placeholder was a template value of the form `₹X,XXX/sqft`. A completion-time content check existed and would have caught it. But it ran in the `onFinish` handler, which is the callback that runs after the response finishes. By then the full response had already streamed to the screen. The buyer had read the placeholder before the check fired. The check produced a Sentry event (Sentry is an error-tracking service) and no remedy.

In Tripwire that shape is matched by `PLACEHOLDER_PRICE_PATTERN`. It is an observe rule. The guard records the match while the stream runs but does not stop it. Stopping it needs a custom pattern in abort mode.

The failure class is every streamed generation. Once a token is yielded to the consumer, it is on their screen and cannot be retracted. So any check that runs after the stream completes is an audit, not a guard.

The harms are a fabricated entity name, a leaked contact detail, a committed discount and a placeholder variable. They share one property: delivery is the harm. A guard that prevents them must run before the token is yielded. That means inside the stream, on every chunk.

The usual objection is cost, because it puts a check on every token in a latency path. That objection is the reason most systems do not do this. Measuring the cost answers it.

## Design goals

G1, catch violations before delivery. The check runs on every chunk, on the accumulated buffer. It can abort before the offending token is yielded. Non-goal: catching violations that need the completed response to detect. Those belong to the batch mode, which accepts that the check runs after delivery.

G2, match across chunk boundaries. The matcher runs on accumulated text, not on the incoming delta, so a violation split across two chunks is still caught. A delta is the new text a chunk adds. Non-goal: matching across the whole response. Rules run on a scan window, the stretch of recent text they match against. The window is the new chunk plus 512 characters. A match longer than that, such as a very long JWT (JSON Web Token), is not seen whole. The window bounds the matching cost. But the guard still keeps the whole stream to release text from, so per-chunk cost grows on long streams. The proxy's `TRIPWIRE_MAX_STREAM_CHARS` caps the stream.

G3, two-tier severity. Hard-abort patterns throw. Observe patterns log and continue. Non-goal: a single uniform severity. Treating every pattern as hard-abort would kill good streams on soft signals. Treating every pattern as observe would deliver the irreversible harms.

G4, low latency cost. Per-chunk overhead must be small against the inter-token gap. The per-chunk cost is orders of magnitude below the provider's inter-token time. It is about 3 microseconds in the committed baseline (`bench/results.txt`), against roughly 15ms. The committed benchmark baseline is the regression-gated number. Non-goal: zero cost. The check is not free, only small, and the design spends that cost deliberately.

G5, coherent abort. On abort the consumer retains the delivered partial plus a structured error, and the application swaps in a safe fallback. Non-goal: silent suppression of the whole response. Blanking punishes the clean majority and looks like the system erasing itself.

## Design

### Mechanism

`StreamingGuard` wraps the token stream (`src/streaming/index.ts`). On every call, `onChunk(chunk)` appends to the raw buffer and evaluates the pattern list against a normalized trailing window. Normalization converts text to one standard form before matching, for example by mapping full-width characters to ASCII. Each pattern carries a mode, abort or observe.

On an abort match the guard throws `GuardAbortError` immediately, before the matched text is released. On an observe match it records a violation once per label and continues.

The scan window is bounded so the matching cost does not grow with response length. The release step still grows (see G2). The guard also withholds the last `holdback` characters. This tail is the hold-back. It means a violation straddling a chunk boundary is caught before its prefix is released.

### Data model

A pattern is a compiled regex plus a label plus a mode (`abort | observe`). Default patterns cover contact-info leaks and business-sensitive leaks as abort. Business-sensitive leaks are commission rates and partner-status claims (`src/patterns/business.ts`). Placeholders, markdown artifacts and price-commitment language are observe.

Callers add patterns through the factory (`createStreamingGuard`). Custom patterns are appended after the built-ins, which cannot be removed. The guard holds the accumulated buffer, the pattern list, an `onViolate` handler and an `onAbort` handler.

### Invariants

1. An abort throws before the matched content is yielded onward.
2. The accumulated buffer, not the delta, is the match target, so boundary-straddling violations are caught.
3. Matching cost per chunk is bounded by the window. Total per-chunk cost is not, and the proxy caps it with the stream size limit.
4. An observe match never blocks the stream. It only records.

### Failure modes covered

- Irreversible leaks reaching the user: covered by abort-before-yield (G1).
- Boundary-split violations: covered by accumulated-buffer matching (G2).
- False-positive stream kills on soft signals: covered by the observe tier (G3).
- Latency regression: the CI (continuous integration) benchmark publishes the per-chunk cost, so a regression is caught (G4).
- Incoherent aborts: covered by partial-plus-fallback (G5).

### Failure modes not covered

- Semantic violations no regex can express. A fabrication that matches no pattern passes. The guard catches mechanical violations. Semantic drift belongs to the eval layer (RFC-adjacent, Goldset) and the post-hoc judge, not the stream.
- Violations detectable only from the completed response. These are deferred to the batch `checkResponse` mode (`src/check/`), which accepts that the check runs after delivery.
- A pattern list that is wrong. The guard enforces the patterns it is given. The operator is responsible for the correctness of the pattern set. The observe tier is a staging ground that mitigates this.

## Alternatives considered

A1, post-hoc check on the completed response. Run all patterns in `onFinish`. Rejected because by the time the response is complete the tokens have been delivered. The check becomes an audit that documents the harm instead of a guard that prevents it. It remains useful as a batch mode for non-streamed or after-the-fact review, which is why it ships as `checkResponse`. But it cannot be the primary guard for streamed output.

A2, per-chunk LLM judge. Ask a second model to evaluate each chunk for policy compliance. Rejected on latency. A model call per chunk multiplies time-to-last-token by orders of magnitude. That turns a guard that costs little into the dominant cost of the response. The regex tier catches the mechanical violation classes, where precision is high. Semantic judgment belongs to a layer that can afford model latency. The per-token path cannot.

A3, uniform hard-abort on any match. Treat every pattern as abort, with no observe tier. Rejected because it destroys good responses on soft signals. A price-commitment phrase or a markdown artifact is not worth killing a stream the user is reading. A guard that often kills good streams is a guard the product disables. The two-tier split is what makes broad pattern coverage shippable. You can add a pattern in observe mode, measure its precision, and promote it only when the data justifies the abort authority.

## Prior art

- OpenAI moderation endpoint: a separate classification call on input or output. Tripwire runs inline and on every chunk, instead of as a discrete call before or after. It trades semantic reach for the ability to abort mid-stream.
- NeMo Guardrails: a policy framework with programmable rails. Tripwire is narrower and lighter. It is a per-chunk regex guard, not a dialogue-management layer. It aims at the abort-before-delivery property specifically.
- Content-Security-Policy in browsers: the closest structural analog. It is a policy enforced at the delivery boundary instead of trusted to the source. Tripwire applies the same enforce-at-the-boundary stance to token streams.

## Open questions

Q1, partial-delivery contract. On abort, is the canonical consumer behavior to keep the partial and render an error part, or to replace the message? The tradeoff: partial-plus-error preserves conversation coherence but shows content the model started and stopped. Replacement is cleaner but discards clean tokens the user read. The answer is likely per application, with the SDK integration exposing both.

Q2, observe-to-abort promotion criteria. What false-positive rate justifies promoting a pattern from observe to abort? The tradeoff is a threshold. Too strict, and useful patterns never earn abort authority. Too loose, and a noisy pattern kills good streams. The answer is a measured precision floor, specific to the corpus.

Q3, window size versus boundary reach. The scan window bounds matching cost. It also bounds how far back a boundary-straddling match can reach. What window catches long-span violations, such as long JWTs, without raising the cost of every chunk? The tradeoff: a larger window catches longer violations at a higher per-chunk cost.

Q4, multi-tenant pattern isolation. Patterns are global to a guard instance. A multi-tenant proxy serves several customers (tenants) from one deployment. Should its patterns be per tenant, and at what cost to the shared compiled-regex efficiency? The tradeoff: per-tenant flexibility against shared-compilation speed.

Q5, interaction with tool-call streams. A tool call is a request from the model to run a function, sent as structured arguments instead of prose. Structured tool-call deltas are not prose. Do prose patterns misfire on them, and should the guard switch mode on content type? The tradeoff: content-type awareness adds complexity but prevents false matches on structured output.

## Rollout

The built-in abort rules (`SECRET_LEAK`, `CONTACT_LEAK`, `BUSINESS_LEAK`) cannot be switched to observe. Any guard that runs them can abort.

Two things can run observe-only first. One is a new rule, added as a custom pattern with mode `observe` and promoted to `abort` once its false-positive rate is known. The other is a shadow run in library mode. In a shadow run, the application feeds a copy of each stream to a guard, logs any `GuardAbortError` it throws, and forwards the original stream unchanged. That measures the built-in abort rules on real traffic without stopping anything. `checkResponse` can also be run over finished replies for the same purpose.

Collect the false-positive rate per pattern from those logs before enabling aborts in the forwarding path. Ship the partial-plus-fallback handling in the application layer before enabling any abort, so the first abort has a coherent consumer experience.

Deploy as a library wrap for in-process use, or as the OpenAI-compatible sidecar for cross-service use. A sidecar is a process that runs next to your app. The sidecar aborts mid-stream and emits a structured SSE error part on a rule trip. SSE (server-sent events) is a way for a server to send a stream of `data:` lines over one HTTP response.

Monitor per-pattern fire rates, abort rates and the CI-published per-chunk cost. A rise in a pattern's fire rate is either drift to investigate or a false-positive spike to demote. The benchmark workflow runs on push, so the per-chunk cost is a regression-gated number, not a one-time measurement.
