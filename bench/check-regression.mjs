// Fail if the current per-chunk cost regressed past 3x the committed baseline.
// Usage: node bench/check-regression.mjs <baseline.txt> <current.txt>
import { readFileSync } from 'node:fs'

const THRESHOLD = 3

function perChunkUs(path) {
  const m = /per_chunk_us=([\d.]+)/.exec(readFileSync(path, 'utf8'))
  if (!m) {
    console.error(`could not find per_chunk_us in ${path}`)
    process.exit(2)
  }
  return parseFloat(m[1])
}

const [baselinePath, currentPath] = process.argv.slice(2)
const baseline = perChunkUs(baselinePath)
const current = perChunkUs(currentPath)
const ratio = current / baseline

console.log(`baseline=${baseline}us current=${current}us ratio=${ratio.toFixed(2)}x (limit ${THRESHOLD}x)`)
if (ratio > THRESHOLD) {
  console.error(`per-chunk cost regressed ${ratio.toFixed(2)}x over baseline`)
  process.exit(1)
}
