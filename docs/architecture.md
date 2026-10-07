# Tripwire architecture

Tripwire is a regex guard for streaming LLM output. It runs as a library at your call site and as an OpenAI-compatible proxy. This document describes what the code actually does. Where a mechanism has a subtlety, the relevant source file is named.

## Why mid-stream

A completion-time check is an audit, not a guard. By the time it runs, the tokens are already on the user's screen. Tripwire matches the accumulated stream on every chunk. It can abort before the matched text is released, so the window in which bad content is visible closes. A chunk is one piece of the stream as it arrives.

A phone number split across three chunks:

1. The user's prompt goes through Tripwire to the upstream LLM. The upstream is the LLM API behind Tripwire.
2. The upstream streams `"call "`, `"98765"` and `"43210"`. Tripwire appends each chunk to its buffer and holds back the last 48 characters. The hold-back is the tail of the stream that the guard keeps instead of releasing.
3. With the third chunk the normalized buffer matches `CONTACT_LEAK`.
4. Tripwire aborts the upstream request.
5. The user receives only the safe prefix the guard had already released (none here, since all 15 characters were still held back), then `{"error":"rule_trip",...}`.

## The hold-back buffer

`StreamingGuard` (`src/streaming/index.ts`) is the core. `onChunk(chunk)`:

1. Appends the chunk to the raw buffer.
2. Normalizes a trailing window (the new chunk plus a fixed overlap) and matches every pattern against it. This window is the scan window. Normalization converts text to one standard form before matching, so look-alike spellings match the same pattern. It is skipped when the window is pure ASCII, so the common path stays cheap.
3. On a hard-abort match: latches `aborted`, calls `onAbort`, and throws `GuardAbortError`. It always throws, even if `onAbort` does not. A latch is a flag that stays set until it is reset. Once latched, every later `onChunk` throws without re-matching until `reset()`.
4. On a soft-observe match: records the violation once per label and calls `onViolate`. The stream continues.
5. Returns the releasable text, which is everything except the last `holdback` characters (default 48). `flush()` releases the held tail at the end. It returns nothing once aborted, because the held tail may precede the violation.

The rules run on a bounded window, but per-chunk cost still grows on long streams. The guard keeps the whole stream in one string and slices each release out of it. V8 (the JavaScript engine in Node) can copy the whole string to take that slice. The proxy caps a stream at `TRIPWIRE_MAX_STREAM_CHARS` (200,000 characters by default), which bounds that cost. The README's Performance section has the details.

Matching runs on normalized text, so unicode evasions (zero-width splits, non-ASCII digits, dash look-alikes) are folded away first (`src/normalize.ts`). A zero-width character, such as a zero-width space, takes no space on screen. Format characters like it are left out when the window and the hold-back are counted, so padding cannot push part of a match out.

### Which rules run

Each guard runs the built-in rules, then the caller's `patterns`. The `builtinRules` option narrows the first group: `true` (the default) keeps them all, `false` drops them, and a list of labels such as `['SECRET_LEAK']` keeps only the rules with those labels. An unknown label throws when the guard is built. The built-in rules are listed in `BUILTIN_RULES` in `src/streaming/index.ts`, and their labels are exported as `BUILTIN_RULE_LABELS`.

The hold-back does not depend on which rules run. It is the `holdback` option, a fixed number of characters, so the same text is released at the same pace with the built-ins on or off. A caller whose own patterns can match a long string has to set it high enough, at least one less than the longest match.

### Why the hold-back matters

Without it, a violation split across chunks would have its safe-looking prefix released before the full pattern became visible. The hold-back is the cost of catching cross-chunk leaks: delivered output lags by the hold-back length.

## Post-hoc audit

Post-hoc means after the response is complete. `checkResponse` (`src/check/`) runs the content rules (not the secret-key pattern) plus the Homesty-specific rules (hallucination, card discipline, language match, price/commission locks) against a completed response. It returns `{ passed, violations }` without throwing.

It is a thin loop over a rule table. A context is built once (`src/check/shared.ts`). Each rule in `src/check/rules/` is a small pure function. It rejects input over `MAX_CHECK_CHARS` (100k) with `InputTooLargeError`.

The audit does not share the guard's rule assembly. Its table is fixed, its rules are functions and not labelled patterns, and it takes no custom patterns, so `builtinRules` does not apply to it.

## Proxy

The proxy (`src/proxy/`) is an Express app exposing `GET /healthz` and `POST /v1/chat/completions`.

The path of one request:

1. An OpenAI client calls the proxy (port 8080 by default) with its own API key as the Bearer token.
2. The proxy sends the request, with that key, to the pinned OpenAI-compatible upstream.
3. The upstream streams its response back to the proxy.
4. The proxy forwards to the client only what its guards release (content, refusal, tool-call and function-call deltas), or a `rule_trip` event when a rule trips. A delta is the small piece of the response that each streamed chunk carries. A tool call is a request from the model to run a function, sent as structured arguments instead of prose.

Per request the handler (`src/proxy/handlers/chat.ts`):

- authenticates the Bearer token (plus an optional proxy token compared with a timing-safe equal). It validates the body (an object, a `messages` array, a `model` string; `stream` must be `true`, `n` must be 1, and `max_tokens` is capped). A non-streaming request is refused with a 400 rather than answered with SSE. SSE (server-sent events) is a way for a server to send a stream of `data:` lines over one HTTP response.
- opens the upstream with an `AbortController` signal, `maxRetries: 0`, and a `baseURL` taken from validated config, never from `OPENAI_BASE_URL`. An `AbortController` signal is the handle the code uses to cancel the request.
- runs every delta string field (content, refusal, tool-call and function-call arguments) through a per-choice guard. Content is forwarded as the guard releases it. A refusal, tool-call or function-call delta is held whole until the aux guard has released the text up to and including it. Then it is forwarded as a synthesized OpenAI delta chunk. When the upstream ends, every guard is flushed. Whatever is still held goes out before `data: [DONE]`, whether or not the upstream sent a `finish_reason`.
- aborts the upstream on a rule trip, a client disconnect, or the per-stream time limit. It caps total streamed characters and honors SSE backpressure. Backpressure is when a slow client makes the server hold off sending more.
- on an upstream failure sends the client only `{ error, upstream_status, message }`, as a 502 body if the stream has not started and as the last SSE event if it has. The full error is logged server-side through `src/proxy/lib/redact.ts`.
- answers a body that is not valid JSON, or is over 1 MB, with the same JSON `invalid_request` shape as any other bad body (`src/proxy/server.ts`).

The app disables `x-powered-by`, rate-limits per IP (429 + `Retry-After`), and caps concurrent streams (503).

## Boot-time config

`loadConfig` (`src/proxy/config.ts`) parses the environment once and fails fast:

- The upstream URL must be a valid `https` URL (http only with `TRIPWIRE_ALLOW_INSECURE_UPSTREAM`). Private, loopback, link-local and metadata addresses are rejected unless `TRIPWIRE_ALLOW_PRIVATE_UPSTREAM` is set. This is the SSRF guard. SSRF (server-side request forgery) is when an attacker tricks a server into calling an address it should not, such as an internal one.
- `TRIPWIRE_BUILTIN_RULES` is parsed into the `builtinRules` option that every guard gets: `all` (or unset), `none`, or a comma list of labels. A label that is not one of `BUILTIN_RULE_LABELS`, an empty entry in the list, or `all` or `none` mixed with labels stops the process at boot, and the error lists the valid labels.
- Custom patterns are parsed from `TRIPWIRE_CUSTOM_PATTERNS`. Invalid JSON, a disallowed flag, a nested quantifier (star height > 1, meaning one repeat inside another, as in `(a+)+`) or a pattern that is slow on an adversarial probe (long runs of letters, digits or spaces) all stop the process at boot, rather than surfacing mid-request. Each probe runs in a `vm` context with a 200 ms timeout. So a pattern such as `(a|a)+$` that would never finish fails the boot instead of hanging it.

See [DEPLOY.md](../DEPLOY.md) for the full environment reference.

## What it does not do

- No ML (machine learning) classification, no multi-turn state machine, no PII redaction of output. PII is personal data such as names and phone numbers.
- No per-tenant policy: one global rule set per proxy.
- No semantic matching: a paraphrased violation that matches no pattern passes.
