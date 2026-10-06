# Claim audit

Every public claim about Tripwire maps to the file that implements it and the
test that proves it. If a row cannot be filled, the claim does not ship. References
are by file rather than line so they do not rot. The test suite is the source of
truth (112 tests across 13 files, run with `npm test`).

Terms used in the tables. The hold-back is the tail of the stream that the guard
keeps until later text rules out a match split across chunks. A delta is the small
piece of the response that each streamed chunk carries. A tool call is a request
from the model to run a function. SSE (server-sent events) is a way for a server
to send a stream of `data:` lines over one HTTP response. A zero-width character
takes no space on screen. ReDoS (regular expression denial of service) is when one
crafted input makes a regex run so long that it freezes the process. SSRF
(server-side request forgery) is when an attacker tricks a server into calling an
address it should not.

## Streaming guard

| Claim | Implemented in | Verified by |
|---|---|---|
| Hard-abort patterns throw `GuardAbortError` mid-stream before the matched text is released | `src/streaming/index.ts` | `tests/streaming.test.ts`, `tests/adversarial/holdback.test.ts` |
| A violation split across chunks never releases its prefix (hold-back buffer), for content and for tool-call, refusal and function-call deltas | `src/streaming/index.ts`, `src/proxy/handlers/chat.ts` (`releaseAux`) | `tests/adversarial/holdback.test.ts`, `tests/adversarial/per-choice.test.ts` |
| Unicode-evaded leaks (zero-width, non-ASCII digits, dash look-alikes) are caught | `src/normalize.ts`, `src/patterns/` | `tests/adversarial/normalize.test.ts` |
| Soft-observe patterns record one violation per label without throwing | `src/streaming/index.ts` | `tests/streaming.test.ts`, `tests/adversarial/abort-correctness.test.ts` |
| A single oversized chunk is rejected (`CHUNK_TOO_LARGE`) | `src/streaming/index.ts` | `tests/adversarial/redos.test.ts` |
| Custom patterns merge with the built-ins and fire | `src/streaming/index.ts` | `tests/proxy/chat.test.ts`, `scripts/smoke-test.js` |

## Post-hoc audit (`checkResponse`)

| Claim | Implemented in | Verified by |
|---|---|---|
| Phone numbers / emails blocked; timestamps and RERA ids are not | `src/check/rules/leaks.ts`, `src/patterns/contact.ts` | `tests/check.test.ts`, `tests/adversarial/normalize.test.ts` |
| Price and investment guarantees blocked | `src/check/rules/guarantees.ts` | `scripts/smoke-test.js` |
| Language mismatch detected for non-Latin Indic scripts | `src/check/rules/language.ts` | `scripts/smoke-test.js` |
| Input over 100k is rejected (`INPUT_TOO_LARGE`) | `src/check/index.ts` | `tests/adversarial/redos.test.ts` |

## Proxy

| Claim | Implemented in | Verified by |
|---|---|---|
| `POST /v1/chat/completions` streams SSE, ends with `[DONE]`, forwards the caller's Bearer token | `src/proxy/handlers/chat.ts` | `tests/proxy/chat.test.ts` |
| Aborts mid-stream on a rule trip with `{"error":"rule_trip",...}` | `src/proxy/handlers/chat.ts` | `tests/proxy/chat.test.ts`, `tests/adversarial/abort-correctness.test.ts` |
| Scans every delta field per choice; rejects `n > 1` | `src/proxy/handlers/chat.ts` | `tests/adversarial/per-choice.test.ts` |
| Upstream URL is pinned; SSRF addresses rejected at boot | `src/proxy/config.ts` | `tests/adversarial/ssrf.test.ts` |
| Custom patterns fail fast on bad JSON / flags / ReDoS shape | `src/proxy/config.ts` | `tests/adversarial/redos.test.ts` |
| Secrets redacted from logs; client sees only `{error, upstream_status}` | `src/proxy/lib/redact.ts`, `src/proxy/handlers/chat.ts` | `tests/adversarial/redaction.test.ts` |
| `x-powered-by` disabled | `src/proxy/server.ts` | `tests/adversarial/redaction.test.ts` |
| Per-IP rate limit (429) and global concurrency cap (503) | `src/proxy/server.ts` | `tests/adversarial/rate-limit.test.ts` |
| `401` on missing auth, `400` on bad body, `502` on upstream failure | `src/proxy/handlers/chat.ts` | `tests/proxy/chat.test.ts`, `tests/adversarial/per-choice.test.ts` |

## Build / CI

| Claim | Implemented in | Verified by |
|---|---|---|
| `npm test` runs once and exits | `package.json` (`vitest run`) | CI `test` job |
| Daemon serves `/healthz` and returns `401` on missing auth | `src/daemon.ts`, `src/proxy/` | CI `test` job (boot check) |
| Published package ships `dist` with type declarations | `package.json`, `tsup.config.ts` | `npm run build` |
| Per-chunk cost is regression-gated | `bench/per-chunk.mjs`, `bench/check-regression.mjs` | `.github/workflows/benchmark.yml` |
