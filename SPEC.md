# Tripwire — Specification

## Overview

@ykstormsorg/tripwire is a TypeScript npm package for LLM response guardrails — real-time content safety for streaming AI outputs and post-hoc audit. It provides regex-based pattern detection for contact leaks, markdown, business-sensitive data, price/commitment leaks, commission leaks, hallucination detection, and status-transition validation.

## Features

### 1. Streaming Guard (`onChunk`)

Run during token stream delivery. Supports **hard-abort** (throw to stop stream) and **soft-observe** (telemetry only) modes per pattern.

```ts
import { createStreamingGuard } from '@ykstormsorg/tripwire'

const guard = createStreamingGuard({
  onAbort: (violation) => { throw new Error(violation) },
  onViolate: (violation) => console.warn('[GUARD]', violation),
})

for (const token of stream) {
  guard.onChunk(token)   // throws if hard-abort pattern fires
  yield token
}
```

### 2. Post-Stream Audit (`checkResponse`)

Full response validation after stream completes. Returns `{ passed, violations[] }`.

```ts
import { checkResponse } from '@ykstormsorg/tripwire'

const result = checkResponse(aiText, {
  knownProjectNames: ['Arialife Heights', 'San Villa'],
  classified: { intent: 'comparison_query', persona: 'premium' },
})
if (!result.passed) {
  result.violations.forEach(v => console.error('[VIOLATION]', v))
}
```

### 3. Status Transition Validation (LOCKS-2)

Pure functions for Builder/Project lock-state state machines. No DB needed.

```ts
import { validateBuilderTransition, reasonRequired } from '@ykstormsorg/tripwire'

const err = validateBuilderTransition('REMOVED', 'BUILDER_HOLD')
if (err) {
  // show err to operator, don't apply action
}
```

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

## Exports

### Patterns (regex)

| Export | Description |
|---|---|
| `CONTACT_LEAK_PATTERN` | Phone numbers (10-digit, +91, xxx-xxx-xxxx) and email addresses |
| `BUSINESS_LEAK_PATTERN` | "commission rate", "partner status", "commission %" |
| `MARKDOWN_PATTERN` | Bold `**`, headers `#`, bullets `-`/`*`/`+` |
| `PLACEHOLDER_NAME_PATTERN` | `[PROJECT_A]`, `[BUILDER_X]`, `[LEGAL_ENTITY_X]` |
| `PLACEHOLDER_PRICE_PATTERN` | `₹X,XXX/sqft`, `₹X.X Cr`, `X.XX%` |
| `PLACEHOLDER_CUID_PATTERN` | `[PROJECT_X_ID]` |
| `PRICE_DISCOUNT_COMMIT_PATTERN` | `X% discount/off/kam` — Lock #1 |
| `PRICE_FINAL_COMMIT_PATTERN` | `final/exact/confirmed/locked + price within 40 chars of ₹` — Lock #1 |
| `COMMISSION_PATTERN` | `X% commission/brokerage/broker fee` — Lock #2 |

### Functions

| Export | Signature |
|---|---|
| `checkResponse` | `(text, opts) => { passed: boolean, violations: string[] }` |
| `createStreamingGuard` | `(handlers, patterns?) => StreamingGuard` |
| `nextBuilderStatus` | `(action: BuilderLockAction) => BuilderStatusValue` |
| `nextProjectStatus` | `(action: ProjectLockAction) => ProjectStatusValue` |
| `validateBuilderTransition` | `(from, action) => string \| null` |
| `validateProjectTransition` | `(from, action) => string \| null` |
| `reasonRequired` | `(action) => boolean` |

### Types

```ts
interface CheckResult { passed: boolean; violations: string[] }

interface CheckOptions {
  knownProjectNames?: string[]
  knownBuilderNames?: string[]
  unverifiedProjectNames?: string[]
  buyerMessage?: string
  classified?: { intent: Intent; persona: Persona }
  // ... internal config
}

interface StreamingGuard {
  onChunk(chunk: string): void
  reset(): void
  get violations(): string[]
}

type BuilderStatusValue = 'ACTIVE' | 'ON_HOLD' | 'SUSPENDED' | 'REMOVED'
type ProjectStatusValue = 'ACTIVE' | 'ON_HOLD' | 'ARCHIVED'
type BuilderLockAction = 'BUILDER_HOLD' | 'BUILDER_SUSPEND' | 'BUILDER_REMOVE' | 'BUILDER_REACTIVATE'
type ProjectLockAction = 'PROJECT_HOLD' | 'PROJECT_ARCHIVE' | 'PROJECT_REACTIVATE'
```

## Design Decisions

1. **No Sentry dependency** — Sentry calls are wrapped in try/catch so the package works without any APM configured.
2. **Pure transition functions** — `validateBuilderTransition` / `validateProjectTransition` have no DB, no async, no side effects.
3. **Pattern conservatism** — All regex patterns are tuned for low false-positive rate. Comments in source explain each decision.
4. **16-token checkpoint awareness** — StreamingGuard can accumulate partial text within a 16-token window for pattern matching (via `accumulated` buffer).
5. **Persona-aware word cap** — `checkResponse` applies different word-count thresholds per persona (`premium: 120`, `value: 80`, default: `100`).
6. **No Markdown CODE fences flagged** — `MARKDOWN_PATTERN` explicitly excludes triple-backtick code fences which legitimate responses may emit.

## Testing

```bash
npm test        # vitest
npm run lint    # eslint
npm run build   # tsc
```

## Version

1.0.0 — Initial extraction from buyerchat LOCKS-1/LOCKS-2.