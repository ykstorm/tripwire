# Tripwire

Regex guardrails for streaming LLM output.

[![npm](https://img.shields.io/npm/v/@ykstormsorg/tripwire.svg)](https://www.npmjs.com/package/@ykstormsorg/tripwire)
[![CI](https://github.com/ykstorm/tripwire/actions/workflows/ci.yml/badge.svg)](https://github.com/ykstorm/tripwire/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Tripwire watches the token stream of an LLM (a large language model) and aborts the response the moment a rule trips, before the offending text reaches the user. A token is one small piece of the response, often a word or part of one.

Tripwire ships two ways. It is a library you import at your call site. It is also an OpenAI-compatible proxy you can run as a sidecar. A sidecar is a small process that runs next to your app and does one job for it.

Tripwire also has a post-hoc audit mode, `checkResponse`. Post-hoc means after the fact: it audits a response once the response is complete, for batch review. The secret-key pattern belongs to the streaming guard and the log redactor, not to this audit.

## What it is

Tripwire is regex-based. It catches mechanical leaks in the stream: API keys, phone numbers, email addresses and fixed phrases. It does not understand meaning. A paraphrased or semantically equivalent violation that matches no pattern gets through.

Tripwire holds back a short tail of the stream so it can catch a violation that straddles a chunk boundary. A chunk is one piece of the stream as it arrives. The held-back tail is called the hold-back. Because of it, output lags delivery by the hold-back length. The default is 48 characters.

## The problem

A streamed response commits tokens to the screen as they are generated. A model can emit a contact-info leak, an unfilled placeholder or a committed discount. By the time any completion-time check runs, the user has already seen it.

Tripwire moves the check inside the stream. On every chunk it matches the accumulated, normalized text, and it can abort before the matched text is released. Normalization converts text to one standard form before matching, so look-alike spellings match the same pattern. More on that under [Unicode normalization](#unicode-normalization).

The key mechanism is the hold-back buffer. The hold-back is the last stretch of the stream that the guard keeps instead of releasing. Suppose the guard released each chunk the instant it arrived. A violation split across chunks (`call ` + `98765` + `43210`) would send its safe-looking prefix before the full pattern was visible. So the guard withholds the last `holdback` characters. It releases them only when enough following context has arrived to rule out a straddling match.

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

`StreamingGuard` wraps a token stream. Call `onChunk(token)` for each token and forward what it returns. Call `flush()` before you close the stream.

`checkResponse` runs the content rules against a completed response. The content rules are contact, booking, fabrication, format, language, placement and the business leaks. It returns the violations without throwing. It does not run the secret-key pattern.

## Features

These patterns hard-abort. A match throws `GuardAbortError` and stops the stream:

- `SECRET_LEAK`: API keys, tokens and private keys the model must never echo (OpenAI/Anthropic `sk-`, Stripe, GitLab, npm, Slack, AWS, Google, JWT, PEM, Bearer)
- `CONTACT_LEAK`: phone numbers and email addresses
- `BUSINESS_LEAK`: commission-rate and partner-status language

These patterns only observe. A match records a violation and never blocks the stream:

- `PLACEHOLDER_LEAK`: unsubstituted template variables such as `[PROJECT_A]`
- `PRICE_COMMITMENT_LEAK` / `COMMISSION_DISCUSSION_LEAK`: committed discounts or quoted commission percentages
- `NO_MARKDOWN`: markdown bullets, bold and headers. The ``` fence markers themselves do not match, but a bullet or header line inside a fence does.

Hard-abort is reserved for irreversible leaks. Promote an observe pattern or add your own with `TRIPWIRE_CUSTOM_PATTERNS`.

### Unicode normalization

Every match runs on normalized text, so common evasions are folded away first. Normalization does four things:

- NFKC, a standard Unicode compatibility form, maps full-width characters to ASCII.
- It strips zero-width format characters. A zero-width character takes no space on screen, like a zero-width space, so it can hide inside a number or a key.
- It maps Indic and Arabic digits to ASCII.
- It folds dash look-alikes to `-`.

A phone number written with Devanagari digits, or a key split by a zero-width space, is still caught.

## Installation

```bash
npm install @ykstormsorg/tripwire
```

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

Tripwire ships an OpenAI-compatible proxy. It accepts requests in OpenAI's `/v1/chat/completions` shape. It forwards them to a pinned upstream, using the caller's own Bearer token. The upstream is the LLM API behind the proxy. Pinned means its URL is fixed in the operator's settings. The proxy holds no upstream key.

The proxy streams the response back as SSE and aborts mid-stream the instant a hard rule fires. SSE (server-sent events) is a way for a server to send a stream of `data:` lines over one HTTP response.

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

The proxy behaves like this:

- `401` on a missing or malformed `Authorization` header (or a wrong proxy token, if configured). The proxy does not check the API key itself. A wrong key is refused by the upstream (see `502`).
- `400` `{ "error": "invalid_request", "detail": ... }` on an invalid body: not valid JSON, not an object, no `messages` array, `model` not a string of 1 to 200 characters, `stream` not `true`, `n` other than 1. `413` with the same shape for a body over 1 MB.
- Streaming only. The guard needs a stream, so a request with `stream: false` or no `stream` field is refused with that `400` instead of being answered with SSE the client did not ask for.
- `502` when the upstream refuses the request. The client gets `{ "error": "upstream_failure", "upstream_status": <n|null>, "message": ... }`. A wrong API key comes back as `upstream_status: 401` with a message saying the upstream rejected the credential. If the upstream breaks after the stream has started, the same object arrives as the last SSE event (with `upstream_status: null` when there is no status) and there is no `data: [DONE]`. The upstream's own error text is logged server-side with secrets redacted.
- `429` with `Retry-After` when the per-IP rate limit is exceeded. `503` when the global concurrency cap is reached.
- Benign prompts stream through and end with `data: [DONE]`.
- Extra abort and observe rules come from `TRIPWIRE_CUSTOM_PATTERNS`, a JSON array of `{ "source", "flags", "label", "mode" }`. They are validated and screened at boot.

See [DEPLOY.md](./DEPLOY.md) for the container setup and the full environment reference.

### Security notes for the proxy

The upstream URL comes only from `TRIPWIRE_UPSTREAM_URL`. Nothing in a request can change it. At boot the host is checked by name. Loopback, private, link-local, CGNAT and cloud metadata addresses are refused, in dotted, numeric, hex and IPv4-mapped IPv6 spellings. So is `localhost`, with or without a trailing dot.

The check never looks up DNS. A public name that resolves to a private address, such as `127.0.0.1.nip.io` or `metadata.google.internal`, is out of scope. Pinning the URL in the operator's settings is the main defence. The name check catches mistakes.

Rate limiting is per client IP. A reverse proxy is a server that sits in front of Tripwire and passes requests on, such as Caddy or nginx. Each reverse proxy between the client and Tripwire is one hop. `TRIPWIRE_TRUST_PROXY` is that hop count. Leave it unset unless every request reaches Tripwire through your own reverse proxies. Then set it to how many there are. Each proxy adds the address it saw to the `X-Forwarded-For` header. Tripwire reads the client address that many entries from the right of that header. If clients can reach the port directly, they can write the header themselves.

Custom patterns come from the operator, not from requests. Each one is probed at boot under a time limit. This catches a pattern that backtracks badly on long runs of letters, digits or spaces. Such a pattern is a ReDoS risk. ReDoS (regular expression denial of service) is when one crafted input makes a regex run so long that it freezes the process. The probe guards against mistakes. It does not make an arbitrary regex safe.

Rate limits and the concurrency cap live in one process's memory, so each replica keeps its own.

## API reference

### `createStreamingGuard(options)` / `new StreamingGuard(options)`

- `onViolate(violation, pattern)`: called when a soft-observe pattern fires.
- `onAbort(violation, pattern)`: called when a hard-abort pattern fires. The guard throws `GuardAbortError` afterwards whether or not this handler throws. An error thrown by the handler is logged with `console.error`, not rethrown.
- `patterns`: custom patterns merged with the built-ins. They do not replace them.
- `holdback`: characters withheld until following context arrives (default 48).

The instance has these members:

- `onChunk(chunk)` returns the releasable text. It throws `GuardAbortError` on a hard match, or if the guard has already aborted.
- `flush()` returns the held-back tail.
- `reset()` clears the buffers, the violations and the abort latch. The latch is the flag that keeps the guard aborted once a hard rule has fired.
- `violations` is the list of observe violations.
- `aborted` reports the latch.

### `checkResponse(text, options?)`

Returns `{ passed: boolean, violations: string[] }`. Throws `InputTooLargeError` if `text` exceeds `MAX_CHECK_CHARS` (100k). Options: `knownProjectNames`, `knownBuilderNames`, `unverifiedProjectNames`, `buyerMessage`, `classified` (`{ intent, persona }`).

### Status transition validation

`validateBuilderTransition`, `validateProjectTransition`, `nextBuilderStatus`, `nextProjectStatus` and `reasonRequired` are pure functions for Builder/Project lock-state machines (no DB, no async).

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

The pattern set is Homesty-specific in places (area/amenity allowlists, Hinglish and Lock rules live in `checkResponse`). The core streaming guard is generic.

## Architecture

```
src/
  normalize.ts          # unicode normalization applied before every match
  patterns/             # exported regex patterns (contact, secret, business, markdown, placeholder, locks1)
  streaming/index.ts    # StreamingGuard (hold-back buffer, GuardAbortError) + createStreamingGuard
  transitions/index.ts  # Builder/Project lock-state helpers
  check/                # checkResponse: shared context + a rule table under check/rules/
  proxy/
    config.ts           # boot-time config parse + validation (upstream pinning, custom patterns)
    server.ts           # Express app (rate limit, concurrency cap)
    start.ts            # shared daemon/CLI boot
    handlers/chat.ts    # guarded POST /v1/chat/completions
    lib/sse.ts          # SSE framing with backpressure
    lib/redact.ts       # secret redaction for logs
    lib/logging.ts      # structured per-request logging
  daemon.ts             # daemon entrypoint
bin/
  tripwire-proxy.ts     # CLI entrypoint
```

The library code (`normalize`, `patterns`, `streaming`, `transitions`, `check`) imports nothing outside Node itself. Only the proxy uses `express` and the `openai` SDK. Both are still listed as dependencies. The `tripwire-proxy` command ships in the same package, so installing the package installs them too.

## Performance

The guard runs on every streamed token, so its cost per chunk has to be small next to the gap between tokens on the network. `bench/per-chunk.mjs` streams a realistic clean response through a fresh guard and reports the steady-state per-chunk cost. The committed baseline is in [`bench/results.txt`](bench/results.txt). The benchmark workflow fails when the cost goes past 3x that baseline. Reproduce with:

```bash
npm run build && node bench/per-chunk.mjs   # pure CPU, no API key
```

That benchmark streams a reply of about 2,600 characters. It shows the cost of a normal reply, not of a long one.

Cost per chunk is not flat on long streams. The rules run on a bounded scan window, the most recent stretch of text the rules match against. But the guard also keeps the whole stream in one string and slices each release out of it. V8, the JavaScript engine in Node, stores a string built by repeated `+=` in pieces. It can copy the whole string to take a slice. So a chunk late in a long stream can cost far more than one early on. How much more depends on the state of the engine at the time. Repeated runs of the same long stream on one machine varied too widely to quote one figure.

In the proxy, `TRIPWIRE_MAX_STREAM_CHARS` caps the stream, and with it this cost. The default is 200,000. A library caller that streams very long replies should cap them the same way.

## What Tripwire does not do

- No LLM-judge layer. An LLM judge is a second model that reads the output and rules on it. Tripwire uses regex patterns instead. It will not catch semantically equivalent violations that match no pattern.
- No published false-positive rate. Thresholds are tunable per pattern. No production hit/miss data is public.
- No policy DB or per-tenant rules. The proxy applies one global rule set. A consumer that needs per-user policy wraps it.

## Try locally

```bash
npm install
npm test          # vitest
npm run build     # dist/index.js + dist/index.mjs + dist/index.d.ts
npm run lint
npm run typecheck
npm run smoke     # guard + custom patterns + checkResponse smoke checks
```

## License

Apache 2.0. See [LICENSE](LICENSE).
