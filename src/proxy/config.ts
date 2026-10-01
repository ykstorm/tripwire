// Proxy configuration - parsed once at boot, fail-fast on anything invalid.
//
// Everything that could make the proxy unsafe at runtime (an SSRF-able upstream
// URL, a catastrophic custom regex, a malformed pattern blob) is validated here
// so a bad config stops the process at startup instead of surfacing mid-request.

import type { CustomPattern } from '../streaming/index.js'

export interface ProxyConfig {
  upstreamUrl: string
  customPatterns: CustomPattern[]
  holdback: number
  maxStreamMs: number
  maxStreamChars: number
  maxConcurrentStreams: number
  rateLimitRpm: number
  trustProxy: boolean
  proxyToken?: string
  defaultMaxTokens: number
}

/** Raised for any invalid configuration; callers at boot print it and exit(1). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Truthy env flag - accepts 1/true/yes/on (case-insensitive), not just "true". */
export function envFlag(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`invalid integer env value: ${value}`)
  return Math.floor(n)
}

// --- Upstream URL validation (SSRF guard) --------------------------------

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return parts
}

function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true // loopback
  if (a === 0) return true // "this host"
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const v4 = ipv4Parts(host)
  if (v4) return isPrivateIPv4(v4)
  // IPv6 literals.
  if (host === '::1' || host === '::') return true
  if (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (mapped) {
    const parts = ipv4Parts(mapped[1])
    if (parts) return isPrivateIPv4(parts)
  }
  return false
}

export function validateUpstreamUrl(
  raw: string,
  opts: { allowInsecure: boolean; allowPrivate: boolean }
): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`TRIPWIRE_UPSTREAM_URL is not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'https:') {
    if (!(url.protocol === 'http:' && opts.allowInsecure)) {
      throw new ConfigError(
        `upstream must be https (got ${url.protocol}); set TRIPWIRE_ALLOW_INSECURE_UPSTREAM=1 to allow http`
      )
    }
  }
  if (isPrivateHost(url.hostname) && !opts.allowPrivate) {
    throw new ConfigError(
      `upstream host ${url.hostname} is private/link-local/loopback; set TRIPWIRE_ALLOW_PRIVATE_UPSTREAM=1 to allow`
    )
  }
  return url.toString().replace(/\/$/, '')
}

// --- Custom pattern parsing + ReDoS screening ----------------------------

const FLAG_WHITELIST = /^[imsu]*$/

interface RawPattern {
  source: string
  flags?: string
  label: string
  mode: 'abort' | 'observe'
}

/**
 * Maximum nesting depth of unbounded repetition (`*`, `+`, `{n,}`) in a regex
 * source. `a+` is 1; `(a+)+` is 2 - the classic catastrophic-backtracking shape.
 */
export function maxStarHeight(source: string): number {
  let i = 0

  function parseAlt(): number {
    let height = parseConcat()
    while (source[i] === '|') {
      i++
      height = Math.max(height, parseConcat())
    }
    return height
  }

  function parseConcat(): number {
    let height = 0
    while (i < source.length && source[i] !== '|' && source[i] !== ')') {
      height = Math.max(height, parseQuantified())
    }
    return height
  }

  function parseQuantified(): number {
    let h = parseAtom()
    // A run of quantifiers can follow; each unbounded one adds a level.
    while (i < source.length) {
      const c = source[i]
      if (c === '*' || c === '+') {
        h += 1
        i++
      } else if (c === '?') {
        i++
      } else if (c === '{') {
        const close = source.indexOf('}', i)
        if (close === -1) break
        const body = source.slice(i + 1, close)
        i = close + 1
        if (/^\d+,$/.test(body)) h += 1 // open-ended {n,}
      } else {
        break
      }
      // consume a lazy '?' modifier after a quantifier
      if (source[i] === '?') i++
    }
    return h
  }

  function parseAtom(): number {
    const c = source[i]
    if (c === '(') {
      i++
      // skip group prefix like ?: ?= ?! ?<name> ?<= ?<!
      if (source[i] === '?') {
        i++
        if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') {
          const close = source.indexOf('>', i)
          if (close !== -1) i = close + 1
        } else {
          // ?: ?= ?! ?<= ?<!
          if (source[i] === '<') i++
          i++
        }
      }
      const inner = parseAlt()
      if (source[i] === ')') i++
      return inner
    }
    if (c === '[') {
      // character class - skip to the closing ], honoring escapes
      i++
      if (source[i] === '^') i++
      if (source[i] === ']') i++
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i++
        i++
      }
      if (source[i] === ']') i++
      return 0
    }
    if (c === '\\') {
      i += 2
      return 0
    }
    i++
    return 0
  }

  return parseAlt()
}

function screenForRedos(pattern: RegExp, label: string): void {
  const probes = [
    'a'.repeat(100_000),
    'a'.repeat(100_000) + '!',
    ('a' + '0').repeat(50_000) + '!',
  ]
  for (const probe of probes) {
    const t0 = process.hrtime.bigint()
    pattern.lastIndex = 0
    pattern.test(probe)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (ms > 20) {
      throw new ConfigError(
        `custom pattern "${label}" is too slow (${ms.toFixed(1)}ms on a 100k probe) - likely catastrophic backtracking`
      )
    }
  }
}

export function parseCustomPatterns(raw: string | undefined): CustomPattern[] {
  if (!raw || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`TRIPWIRE_CUSTOM_PATTERNS is not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError('TRIPWIRE_CUSTOM_PATTERNS must be a JSON array')
  }
  return parsed.map((entry, idx) => {
    const p = entry as RawPattern
    if (!p || typeof p.source !== 'string' || typeof p.label !== 'string') {
      throw new ConfigError(`custom pattern[${idx}] needs string "source" and "label"`)
    }
    if (p.mode !== 'abort' && p.mode !== 'observe') {
      throw new ConfigError(`custom pattern "${p.label}" mode must be "abort" or "observe"`)
    }
    const flags = p.flags ?? 'i'
    if (!FLAG_WHITELIST.test(flags)) {
      throw new ConfigError(`custom pattern "${p.label}" has disallowed flags "${flags}" (allowed: i, m, s, u)`)
    }
    if (maxStarHeight(p.source) > 1) {
      throw new ConfigError(`custom pattern "${p.label}" has nested unbounded quantifiers (star height > 1)`)
    }
    let compiled: RegExp
    try {
      compiled = new RegExp(p.source, flags)
    } catch (err) {
      throw new ConfigError(`custom pattern "${p.label}" failed to compile: ${(err as Error).message}`)
    }
    screenForRedos(compiled, p.label)
    return { pattern: compiled, label: p.label, mode: p.mode }
  })
}

// --- Top-level config load -----------------------------------------------

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const upstreamUrl = validateUpstreamUrl(
    env.TRIPWIRE_UPSTREAM_URL ?? 'https://api.openai.com/v1',
    {
      allowInsecure: envFlag(env.TRIPWIRE_ALLOW_INSECURE_UPSTREAM),
      allowPrivate: envFlag(env.TRIPWIRE_ALLOW_PRIVATE_UPSTREAM),
    }
  )

  return {
    upstreamUrl,
    customPatterns: parseCustomPatterns(env.TRIPWIRE_CUSTOM_PATTERNS),
    holdback: envInt(env.TRIPWIRE_HOLDBACK, 48),
    maxStreamMs: envInt(env.TRIPWIRE_MAX_STREAM_MS, 120_000),
    maxStreamChars: envInt(env.TRIPWIRE_MAX_STREAM_CHARS, 200_000),
    maxConcurrentStreams: envInt(env.TRIPWIRE_MAX_CONCURRENT_STREAMS, 32),
    rateLimitRpm: envInt(env.TRIPWIRE_RATE_LIMIT_RPM, 60),
    trustProxy: envFlag(env.TRIPWIRE_TRUST_PROXY),
    proxyToken: env.TRIPWIRE_PROXY_TOKEN?.trim() || undefined,
    defaultMaxTokens: envInt(env.TRIPWIRE_DEFAULT_MAX_TOKENS, 4096),
  }
}
