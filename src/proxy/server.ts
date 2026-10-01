// Express app for the OpenAI-compatible Tripwire proxy.

import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import { makeChatHandler, type UpstreamFactory } from './handlers/chat.js'
import { loadConfig, type ProxyConfig } from './config.js'
import pkg from '../../package.json'

export interface ProxyServerOptions {
  /** Override the upstream client factory (used by tests to inject a mock). */
  upstreamFactory?: UpstreamFactory
  /** Override the parsed config (defaults to loadConfig() from the environment). */
  config?: ProxyConfig
}

/** Per-IP token bucket rate limiter. Exempts routes it is not mounted on. */
function rateLimiter(rpm: number) {
  const refillPerMs = rpm / 60_000
  const buckets = new Map<string, { tokens: number; last: number }>()
  const retryAfter = Math.max(1, Math.ceil(60 / rpm))
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? 'unknown'
    const now = Date.now()
    const bucket = buckets.get(ip) ?? { tokens: rpm, last: now }
    bucket.tokens = Math.min(rpm, bucket.tokens + (now - bucket.last) * refillPerMs)
    bucket.last = now
    buckets.set(ip, bucket)
    if (bucket.tokens < 1) {
      res.setHeader('Retry-After', String(retryAfter))
      res.status(429).json({ error: 'rate_limited' })
      return
    }
    bucket.tokens -= 1
    next()
  }
}

/** Global in-flight stream limiter. */
function concurrencyLimiter(max: number) {
  let active = 0
  return (req: Request, res: Response, next: NextFunction): void => {
    if (active >= max) {
      res.status(503).json({ error: 'too_many_concurrent_streams' })
      return
    }
    active++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      active--
    }
    res.on('close', release)
    res.on('finish', release)
    next()
  }
}

export function createProxyServer(options: ProxyServerOptions = {}): Express {
  const config = options.config ?? loadConfig()
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', true)
  app.use(express.json({ limit: '1mb' }))

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: pkg.version })
  })

  app.post(
    '/v1/chat/completions',
    rateLimiter(config.rateLimitRpm),
    concurrencyLimiter(config.maxConcurrentStreams),
    makeChatHandler(config, options.upstreamFactory)
  )

  return app
}
