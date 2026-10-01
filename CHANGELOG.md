# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 1.2.0

### Security
- Cross-chunk hold-back buffer in `StreamingGuard`: a violation split across
  chunks no longer delivers its prefix before the full pattern is visible.
  `onChunk` throws `GuardAbortError` on a hard match and latches until `reset()`.
- Unicode normalization before every match (NFKC, zero-width stripping,
  Indic/Arabic digit folding, dash folding), so split and look-alike evasions are
  caught.
- Phone pattern is boundary-anchored (no longer trips on timestamps / RERA ids);
  secret pattern covers modern `sk-`, Stripe, GitLab, npm, Slack, and JWT shapes.
- Proxy: scans every delta field per choice, pins the upstream URL (SSRF guard),
  validates the body, redacts secrets from logs, disables `x-powered-by`, adds an
  optional proxy token, per-IP rate limiting, a concurrency cap, and per-stream
  time/size limits. Custom patterns are validated and ReDoS-screened at boot.

### Changed
- `checkResponse` refactored into a rule table under `src/check/rules/`.
- Published package now ships `dist` only, with type declarations.

## [1.1.0] - 2026-07-18

### Added
- OpenAI-compatible guarded proxy (`POST /v1/chat/completions`), daemon, and CLI.
- `SECRET_LEAK` hard-abort pattern.
- RFC-2 (mid-stream LLM guardrails) design doc.

## [1.0.0] - 2026-05-11

### Added
- Initial release on npm as `@ykstormsorg/tripwire`.
- `StreamingGuard` (hard-abort + soft-observe patterns) and `checkResponse`.
- Pattern library: `CONTACT_LEAK`, `BUSINESS_LEAK`, `PRICE_COMMITMENT_LEAK`,
  `COMMISSION_DISCUSSION_LEAK`, `NO_MARKDOWN`, `PLACEHOLDER_LEAK`.
- Apache 2.0 license.
