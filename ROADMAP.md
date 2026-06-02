# Roadmap

## v1.0 — Current: Core shipped
- [x] `StreamingGuard` — token-by-token, 16-token window, abort/observe modes
- [x] `checkResponse` — post-hoc full-text scan
- [x] Hard-abort patterns: placeholder vars, phone numbers, emails, price manipulation
- [x] Soft-observe patterns: markdown artifacts
- [x] npm package — `@ykstormsorg/tripwire`
- [x] 19 unit tests (12 streaming, 7 check)

## v1.1 — Pattern improvements
- [ ] PII regex refinement (handle international formats, handle split tokens across chunks better)
- [ ] Custom pattern API — allow consumer to register their own patterns at runtime without rebuilding the package

## v1.2 — Observability
- [ ] Violation metrics: count + type per day, exportable for dashboards
- [ ] Abort reason logging with pattern ID for audit trail

## v2.0 — Multi-turn guard
- [ ] Contextual patterns that track state across multiple turns (e.g., "once a price is mentioned, don't let them repeat it")
- [ ] Session-level guard that wraps a conversation history, not just a single response

## Not planned (open issue first)
- Non-English pattern support
- Integration with specific LLM provider SDKs (OpenAI, Anthropic first-party)
- Dynamic pattern loading from external config