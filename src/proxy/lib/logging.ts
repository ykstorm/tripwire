// Structured per-request logging for the proxy.
//
// Emits one JSON line per completed request with latency, abort status, and
// which rule (if any) fired. No external deps — writes to stdout/stderr.

export interface RequestLog {
  ts: string
  route: string
  model?: string
  latencyMs: number
  tokensStreamed: number
  aborted: boolean
  rule?: string
  status: number
}

const LEVEL = (process.env.TRIPWIRE_LOG_LEVEL ?? 'info').toLowerCase()
const QUIET = LEVEL === 'silent' || process.env.NODE_ENV === 'test'

export function logRequest(entry: RequestLog): void {
  if (QUIET) return
  const line = JSON.stringify({ level: entry.aborted ? 'warn' : 'info', ...entry })
  if (entry.aborted) process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export function logSoft(violation: string): void {
  if (QUIET) return
  process.stderr.write(JSON.stringify({ level: 'warn', kind: 'soft_observe', violation }) + '\n')
}
