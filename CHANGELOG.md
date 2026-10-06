# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2.0.0 - unreleased

Four changes break the 1.1.0 API. The `windowSize` option is gone, and
`holdback`, the number of trailing characters the guard withholds, replaces it.
`onChunk` now returns the text that is safe to forward, so callers must forward
what it returns and not their own chunk. The default abort error is now
`GuardAbortError`, which carries a `rule` and has a message such as
`CONTACT_LEAK: pattern matched in stream`, where 1.1.0 threw a plain `Error`
whose message began with `[GUARD_ABORT]`. The proxy now answers a request that
does not set `stream: true` with a JSON 400, where 1.1.0 streamed the reply
regardless.

Everything below is relative to 1.1.0 (2026-06-23, commit `6a9c4e4`).

### Changed (breaking)
- `StreamingGuard.onChunk(chunk)` returns the text that is now safe to forward,
  and `flush()` returns the held-back tail at the end of the stream. The
  hold-back is the last stretch of the stream that the guard keeps instead of
  releasing, so a match split across chunks is caught before its first half goes
  out. Callers must forward what the guard returns, not their own chunk. Code
  written for 1.1.0 (`guard.onChunk(token); yield token`) still runs but gets no
  hold-back.
- The `windowSize` option is gone. `holdback` (default 48 characters) controls
  how much is withheld.
- On an abort rule the guard throws `GuardAbortError` (with `rule`) itself and
  stays aborted until `reset()`. `onAbort` now defaults to a no-op. The 1.1.0
  default threw a plain `Error('[GUARD_ABORT] ...')`. If `onAbort` throws, its
  error is logged and `GuardAbortError` is thrown instead.
- Proxy: a request must set `stream: true`. Anything else gets a 400.
- The package ships `dist` only (1.1.0 also shipped `src`).

### Added
- Proxy: `TRIPWIRE_TRUST_PROXY` is a count of reverse proxies (`1` or `true`
  means one). This is the trust proxy hop count: each reverse proxy between the
  client and Tripwire is one hop. The client IP is read that many entries from
  the right of `X-Forwarded-For`, instead of from the left-most entry.
- Proxy: `TRIPWIRE_RATE_LIMIT_RPM` must be at least 1. `0` stops the boot.
- `SECRET_LEAK` abort rule for API keys and tokens: `sk-` keys, Stripe, GitLab,
  npm, Slack, AWS, GitHub, Google, JWT, PEM private key headers, Bearer tokens
  (added 2026-08-05).
- Hold-back buffer, `flush()`, `GuardAbortError`, `ChunkTooLargeError` and
  `MAX_CHUNK_CHARS`.
- Unicode normalization before every match, exported as `normalize`.
  Normalization converts text to one standard form before matching. It applies
  NFKC (a standard Unicode compatibility form), removes format characters
  (zero-width and bidi controls), maps Indic and Arabic digits to ASCII, and
  maps dash look-alikes to `-`. A zero-width character takes no space on screen.
  Bidi controls are characters that change text direction.
- `checkResponse` throws `InputTooLargeError` above `MAX_CHECK_CHARS` (100,000).
- Proxy: a content guard and an aux guard per choice. A choice is one candidate
  answer in an OpenAI-style response. Tool-call, refusal and function-call
  deltas are held back like content and released only once their text is
  cleared. A delta is the small piece of the response that each streamed chunk
  carries. A tool call is a request from the model to run a function, sent as
  structured arguments instead of prose.
- Proxy: upstream URL pinned and checked at boot (https, no private, loopback,
  link-local or metadata hosts), body validation, optional proxy token, per-IP
  rate limit, concurrency cap, per-stream time and size caps, secrets redacted
  from logs, `x-powered-by` off, and custom patterns validated and
  ReDoS-screened at boot. ReDoS (regular expression denial of service) is when
  one crafted input makes a regex run so long that it freezes the process.
- Proxy: JSON `invalid_request` errors for malformed JSON and bodies over 1 MB.
  Upstream failures carry a `message`, which says when the upstream rejected the
  API key.
- Proxy: on `SIGTERM`, stop accepting connections and let open streams finish
  for up to `TRIPWIRE_MAX_STREAM_MS` before exiting. SIGTERM is the signal a
  platform sends to ask a process to stop. Letting the open streams finish
  first is called a drain.

### Fixed
- The scan window's left edge could trip a clean stream. The scan window is the
  stretch of recent text the rules match against. The end of
  `risk-adjusted-return-on-capital` read as an `sk-` key, and the last ten digits
  of a 15-digit id read as a phone number. Rules now see real text before the
  window.
- Zero-width padding between the halves of a number released its first half or
  hid the match. The hold-back and the window now count visible characters.
- Held tool-call deltas were dropped when the upstream ended without a
  `finish_reason`.
- Seven `checkResponse` regexes carried the `g` flag, which makes a regex
  remember where it last stopped, and missed every other call.
- The phone pattern no longer trips on timestamps or RERA ids.
- The ReDoS screen read `[]` and `[^]` the POSIX way and missed `[^](a+)+$`. A
  pattern such as `(a|a)+$` hung the boot instead of failing. `(\d|\d)+$` was
  not caught at all. Probes now run under a 200 ms timeout and include digit and
  space runs.
- The upstream check rejected public names that start like IPv6 prefixes
  (`fdic.gov`), accepted IPv4-mapped IPv6 spellings of private addresses, and
  accepted `localhost.` with a trailing dot.
- The SSE error event for an upstream that breaks mid-stream now carries
  `upstream_status`, like the 502 body. SSE (server-sent events) is a way for a
  server to send a stream of `data:` lines over one HTTP response.

### Changed
- `checkResponse` is split into a rule table under `src/check/rules/`.

## [1.1.0] - 2026-06-23

### Added
- OpenAI-compatible guarded proxy (`POST /v1/chat/completions`) and the
  `tripwire-proxy` command. The daemon now serves it. Docker image on GHCR (the
  GitHub Container Registry).
- Publish workflow with npm provenance. Provenance is a signed record on npm of
  which repository and build produced a package.

## [1.0.1] - 2026-05-30

### Changed
- Renamed to `@ykstormsorg/tripwire`. This is the first version on npm.

## [1.0.0] - 2026-05-28

Tagged in git only. Never published to npm.

### Added
- `StreamingGuard` (hard-abort + soft-observe patterns) and `checkResponse`.
- Pattern library: `CONTACT_LEAK`, `BUSINESS_LEAK`, `PRICE_COMMITMENT_LEAK`,
  `COMMISSION_DISCUSSION_LEAK`, `NO_MARKDOWN`, `PLACEHOLDER_LEAK`.
- Apache 2.0 license.
