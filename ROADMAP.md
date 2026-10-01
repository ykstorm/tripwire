# Roadmap

## Shipped
- `StreamingGuard` - token-by-token guard with a cross-chunk hold-back buffer,
  hard-abort and soft-observe modes.
- `checkResponse` - post-hoc full-text audit over a rule table.
- Hard-abort patterns: secret leaks, phone numbers, emails, business leaks.
- Soft-observe patterns: markdown, placeholders, price/commission locks.
- OpenAI-compatible guarded proxy with upstream pinning, rate limiting, and
  secret-safe error handling.
- npm package `@ykstormsorg/tripwire`.

## Next
- Pattern refinement: more international phone formats, tighter secret shapes.
- A small metrics surface (violation counts by label) for the proxy.

## Not planned (open an issue first)
- Semantic / LLM-judge matching.
- Multi-turn stateful guards.
- Per-tenant policy storage.
