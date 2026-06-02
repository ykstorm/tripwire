# Architecture — Tripwire

> Detailed design: [docs/architecture.md](docs/architecture.md)

## Component diagram

```mermaid
graph TD
    subgraph "Consumer code"
        Stream[LLM stream<br/>for await chunk]
        Batch[Batch/Audit<br/>checkResponse]
    end

    subgraph "Tripwire"
        SG[StreamingGuard<br/>onChunk token-by-token]
        Patterns[Pattern list<br/>abort + observe]
        Window[Sliding window<br/>16-token buffer]
        Check[checkResponse<br/>post-hoc]
    end

    Stream --> SG
    SG --> Patterns
    Patterns --> Window
    Window --> |abort on match| Stream

    Batch --> Check
    Check --> Patterns

    classDef core fill:#dbeafe,stroke:#1d4ed8
    classDef pattern fill:#fef3c7,stroke:#ca8a04
    classDef window fill:#dcfce7,stroke:#16a34a
    class SG,Patterns,Window core
    class Stream,Batch pattern
```

## Two modes

### Streaming Guard (real-time)

```mermaid
sequenceDiagram
    participant LLM as LLM stream
    participant Guard as StreamingGuard
    participant Pattern as abort/observe patterns

    LLM->>Guard: token "Hello "
    Guard->>Guard: accumulate in window
    Guard->>Pattern: check after every 16 tokens
    Pattern-->>Guard: no match
    Guard-->>LLM: yield token

    loop until abort or end
        LLM->>Guard: token "call 9988776655"
        Guard->>Pattern: 16-token checkpoint
        Pattern-->>Guard: MATCH: phone number
        Guard->>LLM: throw GuardAbortError
        Note over LLM: stream stops, partial delivered
    end
```

### Post-hoc check

```mermaid
sequenceDiagram
    participant Audit as checkResponse(fullText)
    participant Patterns as All patterns
    participant Result

    Audit->>Patterns: run every pattern
    Patterns-->>Audit: violations[]
    Audit->>Result: { passed, violations[] }
```

## Module map

| Module | File | Purpose |
|---|---|---|
| Streaming guard | `src/streaming/index.ts` | Wraps token generator, accumulates 16-token window, fires on abort match |
| Guard factory | `src/streaming/index.ts:createStreamingGuard` | Creates guard with `onAbort` + `onViolate` callbacks |
| Pattern registry | `src/patterns/index.ts` | Hard-abort + soft-observe pattern definitions |
| Post-hoc checker | `src/check/index.ts` | Runs all patterns against completed text |
| Types | `src/types.ts` | `GuardAbortError`, `Violation`, `PatternMatch` |

## Key design decisions

1. **16-token sliding window** — Hard abort fires when accumulated text crosses a pattern match. Smaller window misses violations that span chunks; larger adds latency. 16 tokens is the minimum viable window for phone numbers (10 digits) + context.

2. **Abort throws, observe logs** — `onAbort` throws immediately and stops iteration. The consumer's `try/catch` handles the partial delivery. `onViolate` logs and continues — the stream keeps going.

3. **Partial delivery guarantee** — When abort fires, the user sees whatever was already yielded to them. The consumer's stream loop catches `GuardAbortError`, breaks the loop, and returns the `delivered` string. No silent failure.

## Out of scope

- Multi-language pattern support (English-focused regexes)
- Non-phone contact methods (Discord handles, Telegram usernames)
- Dynamic pattern loading at runtime (static pattern list baked in)
- Integration with specific LLM provider SDKs (generic async iterable interface)