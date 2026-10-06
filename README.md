# Tripwire

**Regex guardrails for streaming LLM output.**

[![npm](https://img.shields.io/npm/v/@ykstormsorg/tripwire.svg)](https://www.npmjs.com/package/@ykstormsorg/tripwire)
[![CI](https://github.com/ykstorm/tripwire/actions/workflows/ci.yml/badge.svg)](https://github.com/ykstorm/tripwire/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Tripwire watches an LLM token stream and aborts the response the moment a rule
trips, before the offending text reaches the user. It ships as a library you
import at your call site and as an OpenAI-compatible proxy you can run as a
sidecar. A post-hoc audit mode (`checkResponse`) runs the content rules over a completed
response for batch review; the secret-key pattern belongs to the streaming guard
and the log redactor, not to the audit.

## What it is, plainly

Tripwire is regex-based. It catches mechanical leaks — API keys, phone numbers,
email addresses, fixed phrases — in the stream. It does not understand meaning,
so it will not catch a paraphrased or semantically-equivalent violation that
matches no pattern. Because it holds back a short tail of the stream to catch
violations that straddle a chunk boundary, output lags delivery by the hold-back
length (48 characters by default).

---

## The problem

A streamed response commits tokens to the screen as they generate. A model that
emits a contact-info leak, an unfilled placeholder, or a committed discount has
already shown it to the user by the time any completion-time check runs. Tripwire
moves the check inside the stream: it matches the accumulated (normalized) text
on every chunk and can abort before the matched text is released.

The key mechanism is a **hold-back buffer**. If the guard released each chunk the
instant it arrived, a violation split across chunks (`call ` + `98765` + `43210`)
would send its safe-looking prefix before the full pattern was visible. Instead
the guard withholds the last `holdback` characters until enough following context
has arrived to rule out a straddling match.

---

## How it works

```
LLM stream tokens
    │
    ▼
StreamingGuard.onChunk(token)
    │   matches normalized accumulated text
    ├── abort pattern matches ─▶ throw GuardAbortError (stops the stream)
    └── observe pattern matches ─▶ record + onViolate, keep streaming
    │
    ▼
returns releasable text (all but the held-back tail); flush() drains the tail
```

**StreamingGuard** wraps a token stream. Call `onChunk(token)` per token and
forward what it returns; call `flush()` before you close the stream.

**checkResponse** runs the content rules (contact, booking, fabrication, format,
language, placement and the business leaks) against a completed response and
returns its violations without throwing. It does not run the secret-key pattern.

---

## Features

**Hard-abort patterns** (throw `GuardAbortError`, stop the stream on match):
- `SECRET_LEAK` — API keys, tokens, and private keys the model must never echo
  (OpenAI/Anthropic `sk-`, Stripe, GitLab, npm, Slack, AWS, Google, JWT, PEM, Bearer)
- `CONTACT_LEAK` — phone numbers and email addresses
- `BUSINESS_LEAK` — commission-rate / partner-status language

**Soft-observe patterns** (record a violation, never block the stream):
- `PLACEHOLDER_LEAK` — unsubstituted template variables such as `[PROJECT_A]`
- `PRICE_COMMITMENT_LEAK` / `COMMISSION_DISCUSSION_LEAK` — committed discounts or
  quoted commission percentages
- `NO_MARKDOWN` — markdown bullets, bold, and headers. The ``` fence markers
  themselves do not match, but a bullet or header line inside a fence does

Hard-abort is reserved for irreversible leaks. Promote an observe pattern or add
your own with `TRIPWIRE_CUSTOM_PATTERNS`.

### Unicode normalization

Every match runs on normalized text, so common evasions are folded away first:
NFKC (full-width to ASCII), zero-width format characters stripped, Indic/Arabic
digits mapped to ASCII, and dash look-alikes folded to `-`. A phone number
written with Devanagari digits or a key split by a zero-width space is still
caught.

---

## Installation

```bash
npm install @ykstormsorg/tripwire
```

---

## Usage

### Streaming guard (real-time)

```typescript
import { createStreamingGuard, GuardAbortError } from '@ykstormsorg/tripwire'

const guard = createStreamingGuard({
  onViolate: (violation, pattern) => console.warn(`[observe] ${violation}`),
})

try {
  for await (const token of llmStream) {
    send(guard.onChunk(token)) // forward only what the guard releases
  }
  send(guard.flush())          // release the held-back tail
} catch (err) {
  if (err instanceof GuardAbortError) {
    // err.rule is the pattern that fired; swap in a safe fallback
  } else {
    throw err
  }
}
```

### Post-hoc audit (batch)

```typescript
import { checkResponse } from '@ykstormsorg/tripwire'

const result = checkResponse(aiText, {
  knownProjectNames: ['Arialife Heights', 'San Villa'],
  classified: { intent: 'comparison_query', persona: 'premium' },
})
if (!result.passed) result.violations.forEach((v) => console.error('[VIOLATION]', v))
```

### Run as a sidecar proxy

Tripwire ships an OpenAI-compatible proxy. It accepts requests in OpenAI's
`/v1/chat/completions` shape, forwards them to a pinned upstream using the
caller's own Bearer token (the proxy holds no upstream key), streams the response
back as SSE, and aborts mid-stream the instant a hard rule fires.

```bash
npm install && npm run build
npm run proxy            # defaults to :8080, override with PORT

curl http://localhost:8080/healthz
# { "ok": true, "version": "1.1.0" }   (version is read from package.json)

curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

On a rule trip the proxy emits a final SSE event and closes the connection:

```
data: {"error":"rule_trip","violation":"CONTACT_LEAK: pattern matched in stream","rule":"CONTACT_LEAK","tokens_streamed":7}
```

Behavior:
- `401` on a missing or malformed `Authorization` header (or a wrong proxy token, if configured).
  The proxy does not check the API key itself; a wrong key is refused by the upstream (see `502`)
- `400` `{ "error": "invalid_request", "detail": ... }` on an invalid body: not valid JSON, not an
  object, no `messages` array, `model` not a string of 1 to 200 characters, `n` other than 1;
  `413` with the same shape for a body over 1 MB
- `502` when the upstream refuses the request — the client gets
  `{ "error": "upstream_failure", "upstream_status": <n|null>, "message": ... }`. A wrong API key
  comes back as `upstream_status: 401` with a message saying the upstream rejected the credential.
  If the upstream breaks after the stream has started, the same object arrives as the last SSE
  event (with `upstream_status: null` when there is no status) and there is no `data: [DONE]`.
  The upstream's own error text is logged server-side with secrets redacted
- `429` with `Retry-After` when the per-IP rate limit is exceeded; `503` when the global concurrency cap is reached
- benign prompts stream through and end with `data: [DONE]`
- extra abort/observe rules via `TRIPWIRE_CUSTOM_PATTERNS` (a JSON array of
  `{ "source", "flags", "label", "mode" }`), validated and screened at boot

See [DEPLOY.md](./DEPLOY.md) for the container setup and the full environment
reference.

---

## API reference

### `createStreamingGuard(options)` / `new StreamingGuard(options)`

- `onViolate(violation, pattern)` — called when a soft-observe pattern fires
- `onAbort(violation, pattern)` — called when a hard-abort pattern fires; the
  guard throws `GuardAbortError` afterwards whether or not this handler throws
- `patterns` — custom patterns **merged with** the built-ins (they do not replace them)
- `holdback` — characters withheld until following context arrives (default 48)

Instance: `onChunk(chunk)` returns the releasable text (and throws
`GuardAbortError` on a hard match or if already aborted); `flush()` returns the
held-back tail; `reset()` clears buffers, violations, and the abort latch;
`violations` is the observe-violation list; `aborted` reports the latch.

### `checkResponse(text, options?)`

Returns `{ passed: boolean, violations: string[] }`. Throws `InputTooLargeError`
if `text` exceeds `MAX_CHECK_CHARS` (100k). Options: `knownProjectNames`,
`knownBuilderNames`, `unverifiedProjectNames`, `buyerMessage`, `classified`
(`{ intent, persona }`).

### Status transition validation

`validateBuilderTransition`, `validateProjectTransition`, `nextBuilderStatus`,
`nextProjectStatus`, and `reasonRequired` are pure functions for Builder/Project
lock-state machines (no DB, no async).

---

## Exported patterns

| Pattern | Type | Description |
|---|---|---|
| `SECRET_LEAK_PATTERN` | abort | Leaked API keys / tokens / private keys |
| `CONTACT_LEAK_PATTERN` / `PHONE_PATTERN` / `EMAIL_PATTERN` | abort | Phone numbers and email addresses |
| `BUSINESS_LEAK_PATTERN` | abort | Commission-rate / partner-status language |
| `MARKDOWN_PATTERN` | observe | Bold `**`, headers `#`, bullets `-` (not fences) |
| `PLACEHOLDER_NAME_PATTERN` | observe | `[PROJECT_A]`, `[BUILDER_X]` tokens |
| `PLACEHOLDER_PRICE_PATTERN` | observe | `₹X,XXX/sqft`, `₹X.X Cr` tokens |
| `PLACEHOLDER_CUID_PATTERN` | observe | `[PROJECT_X_ID]` tokens |
| `PRICE_DISCOUNT_COMMIT_PATTERN` / `PRICE_FINAL_COMMIT_PATTERN` | observe | Committed discount / final price (Lock #1) |
| `COMMISSION_PATTERN` | observe | Quoted commission / brokerage % (Lock #2) |

The pattern set is Homesty-specific in places (area/amenity allowlists, Hinglish
and Lock rules live in `checkResponse`). The core streaming guard is generic.

---

## Architecture

```
src/
  normalize.ts        — unicode normalization applied before every match
  patterns/           — exported regex patterns (contact, secret, business, markdown, placeholder, locks1)
  streaming/index.ts  — StreamingGuard (hold-back buffer, GuardAbortError) + createStreamingGuard
  transitions/index.ts — Builder/Project lock-state helpers
  check/              — checkResponse: shared context + a rule table under check/rules/
  proxy/
    config.ts         — boot-time config parse + validation (upstream pinning, custom patterns)
    server.ts         — Express app (rate limit, concurrency cap)
    start.ts          — shared daemon/CLI boot
    handlers/chat.ts  — guarded POST /v1/chat/completions
    lib/sse.ts        — SSE framing with backpressure
    lib/redact.ts     — secret redaction for logs
    lib/logging.ts    — structured per-request logging
  daemon.ts           — daemon entrypoint
bin/
  tripwire-proxy.ts   — CLI entrypoint
```

The core library (`normalize`, `patterns`, `streaming`, `transitions`, `check`)
has no runtime dependencies. The proxy pulls in `express` and the `openai` SDK.

---

## Performance

The guard runs on every streamed token, so per-chunk cost has to be small next to
the inter-token network gap. `bench/per-chunk.mjs` streams a realistic clean
response through a fresh guard and reports the steady-state per-chunk cost; the
committed baseline is in [`bench/results.txt`](bench/results.txt) and the
benchmark workflow fails on a regression past 3x it. Reproduce with:

```bash
npm run build && node bench/per-chunk.mjs   # pure CPU, no API key
```

Cost per chunk is bounded by a fixed scan window, so it stays flat regardless of
response length.

---

## What Tripwire is NOT

- **No LLM-judge layer.** Regex patterns, not a secondary model. It will not
  catch semantically-equivalent violations that match no pattern.
- **No published false-positive rate.** Thresholds are tunable per pattern; no
  production hit/miss data is public.
- **No policy DB or per-tenant rules.** The proxy applies one global rule set; a
  consumer that needs per-user policy wraps it.

---

## Try locally

```bash
npm install
npm test          # vitest
npm run build     # dist/index.js + dist/index.mjs + dist/index.d.ts
npm run lint
npm run typecheck
npm run smoke     # guard + custom patterns + checkResponse smoke checks
```

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
