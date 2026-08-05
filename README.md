# Tripwire

**Mid-stream LLM safety. Catch the lie before the user finishes reading it.**

[![npm](https://img.shields.io/npm/v/@ykstormsorg/tripwire.svg)](https://www.npmjs.com/package/@ykstormsorg/tripwire)
[![CI](https://github.com/ykstorm/tripwire/actions/workflows/ci.yml/badge.svg)](https://github.com/ykstorm/tripwire/actions/workflows/ci.yml)
[![bench](https://github.com/ykstorm/tripwire/actions/workflows/benchmark.yml/badge.svg)](https://github.com/ykstorm/tripwire/actions/workflows/benchmark.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

A regex/policy guard that watches an LLM token stream and aborts the response the moment a rule trips. Post-hoc audit mode also available for batch reviews.

---

## The problem

LLM streams are all-or-nothing — once you start yielding tokens, you're committed. A model that invents a non-existent project name, commits a fake discount, or leaks a placeholder like `{{PRICE}}` has already delivered the lie. Tripwire lets you stop it mid-sentence.

---

## Why this exists

I extracted this pattern from [Homesty.ai](https://homesty.ai)'s production buyer chat, where a streamed response can carry a contact-info leak, a fabricated discount, or a project name that does not exist in the database. Post-hoc checking meant the violation was delivered, then noticed. Moving the check inside the stream — accumulated-text matching on every chunk, measured at ~4.7 µs per token in CI — converts "the violation got logged" into "the user never saw it". The two-tier split is the design core: hard-abort is reserved for irreversible data leaks, soft-observe covers everything whose false-positive cost exceeds its blast radius, and a pattern earns promotion from observe to abort only after its precision is measured.

---

## How it works

```
LLM stream tokens
    │
    ▼
StreamingGuard  ──▶  Abort patterns (hard triggers)
 (token-by-token)    └── throws immediately on match
    │
    ├──▶  Observe patterns (soft triggers)
          └── logs violation, continues streaming
```

**StreamingGuard** — wraps an async token generator. Calls `onChunk(token)` on each token, checks accumulated text against pattern list, throws immediately on hard-abort match.

**Post-hoc check** — `checkResponse(text)` runs all patterns against a completed response. Returns violations without throwing.

---

## Features at a glance

**Hard-abort patterns** (throw, stop the stream mid-token on match):
- Secret leaks — API keys, access tokens, private keys the model must never echo (`SECRET_LEAK`)
- Contact info — emails, phone numbers in the response (`CONTACT_LEAK`)
- Business entity leaks — non-existent project / builder names (`BUSINESS_LEAK`)

**Soft-observe patterns** (log a structured warning, never block the stream):
- `{{PLACEHOLDER}}` vars — unfilled template variables
- Price manipulation — fabricated discounts or commission claims
- Markdown artifacts — triple-backtick blocks in non-code context

> Hard-abort is reserved for irreversible data leaks (real contact / business
> data). Price and placeholder mentions are observe-only by default to avoid
> false-positive stream kills; promote them with `TRIPWIRE_CUSTOM_PATTERNS`.

---

## Installation

```bash
npm install @ykstormsorg/tripwire
```

Or start from source:

```bash
git clone https://github.com/ykstorm/tripwire.git
cd tripwire
npm install
```

---

## Usage

### Streaming guard (real-time)

```typescript
import { createStreamingGuard } from '@ykstormsorg/tripwire'

const guard = createStreamingGuard({
  onAbort: (violation, pattern) => {
    throw new Error(`[TRIPWIRE] ${violation}`)
  },
  onViolate: (violation, pattern) => {
    console.warn(`[observe] ${violation}`)
  }
})

for await (const token of llmStream) {
  guard.onChunk(token) // throws mid-stream on abort pattern
  yield token
}
```

### Post-hoc audit (batch)

```typescript
import { checkResponse } from '@ykstormsorg/tripwire'

const result = checkResponse(llmResponseText)
if (result.violations.length > 0) {
  console.log('Violations:', result.violations)
}
```

### Post-hoc audit with context

```typescript
const result = checkResponse(aiText, {
  knownProjectNames: ['Arialife Heights', 'San Villa'],
  classified: { intent: 'comparison_query', persona: 'premium' }
})
if (!result.passed) {
  result.violations.forEach(v => console.error('[VIOLATION]', v))
}
```

### Run as a sidecar proxy

Tripwire ships an OpenAI-compatible proxy. It accepts requests in OpenAI's
exact `/v1/chat/completions` shape, forwards them upstream using the caller's
own Bearer token (no key management on the proxy), streams the response back as
SSE, and **aborts mid-stream** the instant a hard rule fires.

```bash
# from a clone — build then run (defaults to :8080, override with PORT)
npm install && npm run build
npm run proxy            # or: node dist/daemon.js  /  npx tripwire-proxy

# health
curl http://localhost:8080/healthz
# { "ok": true, "version": "1.0.1" }

# stream a completion through the guard
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
- `401` on missing/invalid `Authorization` header
- `502` on upstream failure (bad key, network)
- benign prompts stream through unchanged and end with `data: [DONE]`
- soft-observe rules log a structured warning but never block the stream
- extra abort/observe rules via `TRIPWIRE_CUSTOM_PATTERNS` (JSON array of
  `{ "source", "flags", "label", "mode" }`)

Run it as a container or Kubernetes sidecar — see [DEPLOY.md](./DEPLOY.md).

---

## API reference

### `createStreamingGuard(options)`

Wraps a token stream. Returns a `StreamingGuard` instance.

**Options:**
- `onAbort(violation, pattern)` — called when a hard-abort pattern fires; throw to stop streaming
- `onViolate(violation, pattern)` — called when a soft-observe pattern fires; non-fatal
- `patterns` — optional list of custom pattern objects (defaults to all built-ins)

**StreamingGuard instance:**
- `onChunk(chunk)` — call once per token
- `reset()` — clear accumulated buffer
- `violations` — array of soft-observe violations from the current stream

### `checkResponse(text, options?)`

Runs all patterns against a completed response.

**Returns:** `{ passed: boolean, violations: string[] }`

**Options:**
- `knownProjectNames` — whitelist of real project names
- `knownBuilderNames` — whitelist of real builder names
- `unverifiedProjectNames` — names detected but not yet confirmed
- `buyerMessage` — original user query (used for persona-aware word caps)
- `classified` — `{ intent, persona }` for intent-specific checks

### Status transition validation

```typescript
import {
  validateBuilderTransition,
  validateProjectTransition,
  nextBuilderStatus,
  nextProjectStatus,
  reasonRequired
} from '@ykstormsorg/tripwire'

// Validate a Builder status transition
const err = validateBuilderTransition('REMOVED', 'BUILDER_HOLD')
if (err) {
  // show err to operator, don't apply action
}

// Get next status for an action
const nextStatus = nextBuilderStatus('BUILDER_SUSPEND')

// Check if a reason is required before applying an action
if (reasonRequired('BUILDER_REMOVE')) {
  // prompt operator for reason before proceeding
}
```

---

## Exported patterns

| Pattern | Type | Description |
|---|---|---|
| `SECRET_LEAK_PATTERN` | abort | Leaked API keys / tokens / private keys (OpenAI, Anthropic, AWS, GitHub, Google, Slack, PEM, long Bearer) |
| `CONTACT_LEAK_PATTERN` | abort | Phone numbers and email addresses |
| `BUSINESS_LEAK_PATTERN` | abort | Commission rate, partner status mentions |
| `MARKDOWN_PATTERN` | observe | Bold `**`, headers `#`, bullets `-` |
| `PLACEHOLDER_NAME_PATTERN` | observe | `[PROJECT_A]`, `[BUILDER_X]` tokens |
| `PLACEHOLDER_PRICE_PATTERN` | observe | `₹X,XXX/sqft`, `₹X.X Cr` tokens |
| `PLACEHOLDER_CUID_PATTERN` | observe | `[PROJECT_X_ID]` tokens |
| `PRICE_DISCOUNT_COMMIT_PATTERN` | observe | `X% discount/off/kam` — Lock #1 |
| `PRICE_FINAL_COMMIT_PATTERN` | observe | `final/exact/confirmed/locked + price` — Lock #1 |
| `COMMISSION_PATTERN` | observe | `X% commission/brokerage` — Lock #2 |

---

## Architecture

```
src/
  patterns/
    index.ts          — all exported patterns + helpers
    contact.ts        — CONTACT_LEAK_PATTERN
    business.ts       — BUSINESS_LEAK_PATTERN
    markdown.ts       — MARKDOWN_PATTERN
    placeholder.ts    — PLACEHOLDER_*_PATTERN
    locks1.ts         — PRICE_DISCOUNT_COMMIT_PATTERN, PRICE_FINAL_COMMIT_PATTERN, COMMISSION_PATTERN
  streaming/
    index.ts          — StreamingGuard class + createStreamingGuard
  transitions/
    index.ts          — actions, nextBuilderStatus, nextProjectStatus, validate*Transition, reasonRequired
  proxy/
    server.ts         — Express app (createProxyServer)
    handlers/chat.ts  — POST /v1/chat/completions guarded streaming handler
    lib/sse.ts        — SSE framing helpers
    lib/logging.ts    — structured per-request logging
  check.ts            — checkResponse (the main audit function)
bin/
  tripwire-proxy.ts   — CLI entrypoint for the proxy
```

The core library (`patterns`, `streaming`, `transitions`, `check`) has **no
runtime dependencies**. The optional sidecar proxy pulls in `express` and the
`openai` SDK.

---

## Performance

The guard runs on the hot path of every streamed token, so its overhead has to
be negligible next to the network gap between tokens. Measured in CI (GitHub
Actions `ubuntu-latest`, Node 20) by
[`.github/workflows/benchmark.yml`](.github/workflows/benchmark.yml) on every
push, streaming a realistic ~520-token response through a fresh guard:

| Metric | Result |
|---|---|
| Per-chunk overhead (happy path) | **~4.7 µs** |
| Throughput | **~210k chunks/sec** |
| Sample | 10.4M chunks (20k streams × 521 tokens) |

That is under 5 microseconds per token — roughly **3000× smaller** than the
~15 ms a real provider takes between tokens, so the guard adds no perceptible
latency. Reproduce with `node bench/per-chunk.mjs` (pure CPU, no API key). The
accumulation window is bounded, so cost stays flat regardless of response
length.

---

## Stack

- **Runtime** — Node.js 18+
- **Types** — TypeScript
- **Build** — tsup
- **Tests** — Vitest
- **License** — Apache 2.0

---

## What Tripwire is NOT

- **No LLM-judge layer.** Tripwire uses regex patterns, not a secondary model. It won't catch semantically equivalent lies that don't match a pattern.
- **No false-positive rate published.** The abort threshold is tunable per pattern but no production hit/miss data is public.
- **No per-user policy store.** Policies are global — if you need user-specific rules, you need a wrapping layer.
- **Single-tenant in-process use.** Designed as a library imported into your API, not a standalone microservice with a policy DB.

---

## Try locally

```bash
npm install
npm test        # 2 test suites
npm run build   # produces dist/index.js + dist/index.mjs
npm run lint    # eslint
npm run typecheck # TypeScript check
```

---

## Contributing

Contributions welcome. Please open an issue first to discuss large changes.

```bash
git clone https://github.com/ykstorm/tripwire.git
cd tripwire
npm install
# make changes, add tests
npm test
# PR against main
```

---

## License

Apache 2.0 — see [LICENSE](LICENSE).