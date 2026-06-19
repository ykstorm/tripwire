# Claim audit — last verified 2026-06-19

Every public claim about Tripwire mapped to the file:line that implements it and
the test that proves it. If a row can't be filled, the claim doesn't ship.

## OpenAI-compatible sidecar proxy

| Claim | File:line implementing | Verified by |
|---|---|---|
| Exposes `POST /v1/chat/completions` in OpenAI's request shape | `src/proxy/server.ts:19` | `tests/proxy/chat.test.ts:56` (benign stream round-trips) |
| Exposes `GET /healthz` | `src/proxy/server.ts:15` | `tests/proxy/chat.test.ts:148`; live curl → `{"ok":true}` |
| Forwards to OpenAI with the caller's Bearer token (no key on proxy) | `src/proxy/handlers/chat.ts:65-67` (`upstreamFactory(apiKey)` from `auth.slice(7)`) | live curl with bad key → `502` (real SDK rejected key) |
| Streams chunks back as SSE, ends with `data: [DONE]` | `src/proxy/handlers/chat.ts:100-104`, `src/proxy/lib/sse.ts:30-36` | `tests/proxy/chat.test.ts:61` |
| Runs each token through `createStreamingGuard` before forwarding | `src/proxy/handlers/chat.ts:99` (guard runs before `writeSSE`) | `tests/proxy/chat.test.ts:84-91` (banned token never forwarded) |
| Aborts mid-stream on hard rule trip with `{"error":"rule_trip",...}` then closes | `src/proxy/handlers/chat.ts:80-86` | `tests/proxy/chat.test.ts:72-94` |
| `401` on missing/invalid Bearer | `src/proxy/handlers/chat.ts:56-59` | `tests/proxy/chat.test.ts:129-133`; live curl → `401` |
| `502` on upstream failure | `src/proxy/handlers/chat.ts:68-70` | `tests/proxy/chat.test.ts:136-139`; live curl → `502` |
| Soft-observe rules log a warning, never block the stream | `src/proxy/handlers/chat.ts:88-90`, `src/proxy/lib/logging.ts:33-36` | `tests/proxy/chat.test.ts:99-107` |
| Structured per-request log (latency, abort, rule fired) | `src/proxy/lib/logging.ts:18-31`, `src/proxy/handlers/chat.ts:117-127` | manual: JSON line emitted per request |
| Custom abort/observe patterns via `TRIPWIRE_CUSTOM_PATTERNS` | `src/proxy/handlers/chat.ts:35-49` | `tests/proxy/chat.test.ts:110-126` (env pattern aborts) |
| Ships as a CLI (`tripwire-proxy`) and daemon | `bin/tripwire-proxy.ts`, `src/daemon.ts`, `package.json` `bin` field | live: `node dist/daemon.js` + `node dist/bin/tripwire-proxy.js` both serve `/healthz` 200 |

## Streaming guard library

| Claim | File:line implementing | Verified by |
|---|---|---|
| `createStreamingGuard({ onAbort, onViolate, patterns })` single-options API | `src/streaming/index.ts:143-150` | `tests/streaming.test.ts`; README §API reference |
| Custom `patterns` MERGE with built-ins and actually fire (was a no-op TODO) | `src/streaming/index.ts:100-104` | `scripts/smoke-test.js:135` + `tests/proxy/chat.test.ts:110-126` |
| Hard-abort patterns throw mid-stream; banned token never delivered | `src/streaming/index.ts:124-127` | `tests/streaming.test.ts:7-25`; `scripts/smoke-test.js` "hard abort delivers partial" |
| Soft-observe patterns collect into `.violations` without throwing | `src/streaming/index.ts:128-131` | `tests/streaming.test.ts:66-97` |
| `reset()` clears accumulated buffer + violations | `src/streaming/index.ts:135-138` | `tests/streaming.test.ts:99-115` |

## Post-hoc audit (`checkResponse`)

| Claim | File:line implementing | Verified by |
|---|---|---|
| Phone numbers blocked (CONTACT_LEAK) | `src/check.ts:213-215` | `scripts/smoke-test.js:40-44` |
| Email addresses blocked incl. hyphenated/multi-label domains | `src/check.ts:216-218`, `src/patterns/contact.ts:5` | `scripts/smoke-test.js:46-50` |
| Price guarantee blocked (PRICE_GUARANTEE) | `src/check.ts:230-235` | `scripts/smoke-test.js:52-56` |
| Investment guarantee blocked | `src/check.ts:225-228` | `scripts/smoke-test.js:58-62` |
| Language mismatch detected for non-Latin Indic scripts (incl. Kannada) | `src/check.ts:262-281` | `scripts/smoke-test.js:64-71` |

## Build / CI

| Claim | File:line implementing | Verified by |
|---|---|---|
| `npm test` runs once and exits (no watch-mode hang) | `package.json:34` (`"test": "vitest run"`) | `npx vitest run` → 26 passed, exits 0 |
| `npm run test:watch` for watch mode | `package.json:35` | — |
| Docker image runs the proxy daemon on `$PORT` (default 8080) | `Dockerfile` `CMD ["node","dist/daemon.js"]`, `src/daemon.ts:10` | Dockerfile correct; daemon verified locally (Docker daemon down on build host) |
