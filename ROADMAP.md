# Roadmap

## Shipped
- `StreamingGuard`: a token-by-token guard with a cross-chunk hold-back buffer, hard-abort and soft-observe modes. The hold-back is the tail of the stream that the guard keeps until later text rules out a match split across chunks. Hard-abort stops the stream on a match. Soft-observe only records it.
- `checkResponse`: a post-hoc full-text audit over a rule table. Post-hoc means after the response is complete.
- Hard-abort patterns: secret leaks, phone numbers, emails, business leaks.
- Soft-observe patterns: markdown, placeholders, price/commission locks.
- OpenAI-compatible guarded proxy with upstream pinning, rate limiting, and secret-safe error handling. Upstream pinning fixes the URL of the LLM API behind the proxy, so a request cannot change it.
- npm package `@ykstormsorg/tripwire`.

## Next
- Pattern refinement: more international phone formats, tighter secret shapes.
- A small metrics surface (violation counts by label) for the proxy.

## Not planned (open an issue first)
- Semantic / LLM-judge matching. An LLM judge is a second model that reads the output and rules on it.
- Multi-turn stateful guards, which remember earlier turns of a conversation.
- Per-tenant policy storage, which means a separate rule set for each customer.
