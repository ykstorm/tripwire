# Tripwire

**Mid-stream LLM safety. Catch the lie before the user finishes reading it.**

[![npm](https://img.shields.io/npm/v/@ykstormsorg/tripwire.svg)](https://www.npmjs.com/package/@ykstormsorg/tripwire)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

A regex/policy guard that watches an LLM token stream and aborts the response the moment a rule trips. Post-hoc audit mode also available for batch reviews.

---

## The problem

LLM streams are all-or-nothing — once you start yielding tokens, you're committed. A model that invents a non-existent project name, commits a fake discount, or leaks a placeholder like `{{PRICE}}` has already delivered the lie. Tripwire lets you stop it mid-sentence.

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

**Hard-abort patterns** (throw on match):
- `{{PLACEHOLDER}}` vars — unfilled template variables
- Business entity leaks — non-existent project/builder names
- Contact info — emails, phone numbers in response
- Price manipulation — fabricated discounts or commission claims

**Soft-observe patterns** (log only):
- Markdown artifacts — triple-backtick blocks in non-code context

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
| `CONTACT_LEAK_PATTERN` | abort | Phone numbers and email addresses |
| `BUSINESS_LEAK_PATTERN` | abort | Commission rate, partner status mentions |
| `MARKDOWN_PATTERN` | observe | Bold `**`, headers `#`, bullets `-` |
| `PLACEHOLDER_NAME_PATTERN` | abort | `[PROJECT_A]`, `[BUILDER_X]` tokens |
| `PLACEHOLDER_PRICE_PATTERN` | abort | `₹X,XXX/sqft`, `₹X.X Cr` tokens |
| `PLACEHOLDER_CUID_PATTERN` | abort | `[PROJECT_X_ID]` tokens |
| `PRICE_DISCOUNT_COMMIT_PATTERN` | abort | `X% discount/off/kam` — Lock #1 |
| `PRICE_FINAL_COMMIT_PATTERN` | abort | `final/exact/confirmed/locked + price` — Lock #1 |
| `COMMISSION_PATTERN` | abort | `X% commission/brokerage` — Lock #2 |

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
  check.ts            — checkResponse (the main audit function)
```

~762 LOC. No runtime dependencies.

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