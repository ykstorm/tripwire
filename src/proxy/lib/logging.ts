// Structured per-request logging for the proxy.
//
// Emits one JSON line per completed request with latency, abort status, and
// which rule (if any) fired. No external deps - writes to stdout/stderr.

interface RequestLog {
  ts: string
  route: string
  model?: string
  latencyMs: number
  tokensStreamed: number
  aborted: boolean
  rule?: string
  status: number
  /** Redacted server-side error detail (never sent to the client). */
  detail?: string
}

const LEVEL = (process.env.TRIPWIRE_LOG_LEVEL ?? 'info').toLowerCase()
const QUIET = LEVEL === 'silent' || process.env.NODE_ENV === 'test'

export function logRequest(entry: RequestLog): void {
  if (QUIET) return
  const warn = entry.aborted || entry.status >= 500
  const line = JSON.stringify({ level: warn ? 'warn' : 'info', ...entry })
  if (warn) process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export function logSoft(violation: string): void {
  if (QUIET) return
  process.stderr.write(JSON.stringify({ level: 'warn', kind: 'soft_observe', violation }) + '\n')
}
