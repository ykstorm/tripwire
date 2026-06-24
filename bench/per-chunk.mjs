// Per-chunk overhead microbenchmark for the streaming guard (happy path).
// Streams a realistic ~640-token clean assistant response through a fresh
// guard per stream, calling onChunk() per token, and reports the steady-state
// per-chunk cost. No network/API — pure CPU (regex over the bounded window).
// Run: node bench/per-chunk.mjs
import { createStreamingGuard } from '../dist/index.mjs'

const text = `Here is a concise summary of the quarterly engineering review. The platform team shipped the new ingestion pipeline ahead of schedule and reduced median request latency across all regions. Reliability work focused on idempotent retries and back pressure, which cut duplicate processing to near zero during the last incident window. The data team migrated the warehouse to a partitioned layout, improving scan performance on the largest tables and lowering nightly batch cost. On the product side we launched the redesigned onboarding flow, instrumented every step, and saw a meaningful lift in completion. Documentation was refreshed and the runbooks now cover the most common on call scenarios. Next quarter the focus shifts to streaming evaluation, tighter rollout gating, and broader observability across the request path so regressions surface before they reach customers.`.repeat(2)
const tokens = text.split(/(\s+)/).filter(Boolean)
const STREAMS = 20000

function run() {
  let chunks = 0
  const t0 = process.hrtime.bigint()
  for (let s = 0; s < STREAMS; s++) {
    const guard = createStreamingGuard()
    for (const tok of tokens) { guard.onChunk(tok); chunks++ }
  }
  const ns = Number(process.hrtime.bigint() - t0)
  return { chunks, perChunkUs: (ns / chunks) / 1000, mcps: chunks / (ns / 1e9) / 1e6 }
}

run() // warm-up
const r = run()
console.log(`tokens/stream=${tokens.length} streams=${STREAMS} total_chunks=${r.chunks}`)
console.log(`per_chunk_us=${r.perChunkUs.toFixed(3)}`)
console.log(`throughput_M_chunks_per_sec=${r.mcps.toFixed(2)}`)
console.log(`node=${process.version}`)
