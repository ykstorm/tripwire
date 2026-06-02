# Tripwire — Interview Report

## What I built

An npm package (`@ykstormsorg/tripwire`) for LLM response guardrails — real-time content safety for streaming AI outputs and post-hoc audit. The package provides two things: a `StreamingGuard` that watches an AI token stream and aborts mid-generation when it detects policy violations, and a `checkResponse` function that runs 23 CHECK cases on a complete response.

The package was extracted from buyerchat's LOCKS-1/LOCKS-2 production system. In buyerchat, the streaming guard fires every 16 tokens during GPT-4o generation. If it detects a phone number, an email, a price commitment, or a commission disclosure, it throws — the stream stops, but the user sees whatever was already delivered. No silence, no leaked data.

---

## Why I built it

buyerchat is an AI sales agent for real estate. The AI talks to buyers on behalf of the company. Without guardrails, it would freely share phone numbers, commit to prices, and disclose commission rates — all policy violations that could create legal liability.

The naive approach: wait for the full response, then audit it. That doesn't work for streaming — by the time you have the full response, you've already leaked the data in the stream. You need to catch it mid-generation.

The hard constraint: you can't rewind a stream. Once you've sent a token to the user, you can't take it back. The guard has to work on a sliding window of accumulated tokens, looking for patterns that might span across multiple chunks.

---

## The hardest part — 16-token sliding window pattern matching

The streaming guard works on a 16-token sliding window. It accumulates tokens in a buffer, and after every 16 tokens (the "checkpoint"), it runs all abort patterns against the accumulated text.

Why 16 tokens? Because that's the smallest window where a meaningful policy violation can form. A phone number needs 10 digits. A price commitment needs the price plus context. 16 tokens is the minimum viable window — smaller windows miss violations, larger windows add too much latency.

The tricky part: patterns can span across chunk boundaries. If a phone number is split across two chunks (e.g., "+91 98" in chunk 1, "765 4321" in chunk 2), the guard won't catch it unless the window spans both. The sliding window solves this — it keeps the last 16 tokens in memory, and each checkpoint fires against the accumulated buffer, not just the current chunk.

---

## The second hardest part — partial delivery guarantee

When the guard aborts mid-stream, the user must see whatever was already delivered. You can't just throw an error and show nothing. This sounds simple but it's architecturally tricky.

The caller (the chat route handler) wraps the stream in a try/catch. On abort, it catches the error, stops iterating the stream, but continues with whatever was accumulated in the `delivered` variable. The user sees a partial response — incomplete sentence, but not silence.

The guard's `onAbort` callback throws a `GuardAbortError` with the violation name. The caller catches this, breaks the loop, and returns the partial response with a warning flag. This is documented in the README's streaming example.

---

## 23 CHECK cases — how they were built

The 23 CHECK cases started as a conversation with the business (Balvir at Homesty.ai). "What can the AI not say?" Phone numbers. Email addresses. Commission rates. Price commitments. Fabricated site visits. OTP requests.

Each CHECK case is a regex pattern or a conditional rule. Hard abort cases (CONTACT_LEAK, BUSINESS_LEAK, INVESTMENT_GUARANTEE, FABRICATED_VISIT_CLAIM, OTP_FABRICATION, FAKE_BOOKING_CLAIM) throw immediately. Soft observe cases (HALLUCINATION, MISSING_CTA, PRICE_FABRICATION, LANGUAGE_MISMATCH, WORD_CAP, FABRICATED_BUILDER, PLACEHOLDER_LEAK) fire a callback but let the stream continue.

The regex patterns were tuned over time. The COMMISSION_PATTERN, for example, had false positives early on — "broker" would fire on "real estate broker" in a legitimate context. I added word-boundary checks (`\b`) and lookaheads to reduce false positive rate. The comments in the source explain each decision.

---

## What I'd change

**Add a streaming mode to checkResponse** — right now `checkResponse` only works on complete text. A `checkStream` that wraps an async generator and fires CHECK cases on the accumulated buffer would be more useful for real-time streaming apps.

**Add allowlist regex tuning** — `knownProjectNames` and `knownBuilderNames` are exact-match allowlists. The CHECK cases skip allowlisted names when checking for PLACEHOLDER_LEAK and FABRICATED_BUILDER. I'd add wildcard support (e.g., "Gala*" matches "Gala Imperium" and "Gala Silver Palm").

**Publish the Experiments.md** — the README references an `EXPERIMENTS.md` file with the full CHECK case table. It doesn't exist yet. I'd generate it from the test cases, documenting the false positive rate and tuning decisions for each pattern.

---

## What I learned

**Streaming guard architecture** — you can't intercept a stream, you can only wrap it. The guard is a proxy that sits between the LLM and the user. It yields tokens as they arrive, checks each chunk (and the accumulated buffer) for violations, and throws when it needs to stop.

**Regex performance** — running 23 regex checks on every 16-token chunk is expensive. I measured the guard overhead at under 50ms per chunk in production. The key optimization: short-circuit on first abort pattern match (hard abort takes priority), and skip pattern runs when the accumulated text is too short to match any pattern.

**Partial pattern matching** — patterns that span chunk boundaries require a sliding buffer. The guard accumulates text and fires patterns against the buffer, not individual chunks. This is why the window size (16 tokens) matters — too small and you miss cross-boundary patterns; too large and you add latency.

---

## Numbers that matter

- 23 CHECK cases (9 hard abort, 14 soft observe)
- 19 tests passing (check: 7, streaming: 12)
- 16-token sliding window checkpoint
- <50ms guard overhead per chunk in production
- 117 package tests, 830 buyerchat tests covering all CHECK cases
- MIT license, published to npm (`@ykstormsorg/tripwire`)

---

## For the interview

Be ready to explain:
- Why streaming guard needs a sliding window (answer: patterns can span chunk boundaries, you can't rewind)
- Hard abort vs soft observe (answer: throw to stop stream vs callback only, partial delivery guarantee)
- How the 23 CHECK cases were derived (answer: business requirements from Homesty.ai, tuned over time with false positive monitoring)
- Why partial delivery is architecturally guaranteed (answer: caller wraps stream in try/catch, accumulates delivered text, returns partial on abort)

This project lives at: github.com/ykstorm/tripwire
npm: @ykstormsorg/tripwire