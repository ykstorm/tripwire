// Express app for the OpenAI-compatible Tripwire proxy.

import express, { type Express } from 'express'
import { makeChatHandler, type UpstreamFactory } from './handlers/chat.js'

export interface ProxyServerOptions {
  /** Override the upstream client factory (used by tests to inject a mock). */
  upstreamFactory?: UpstreamFactory
}

export function createProxyServer(options: ProxyServerOptions = {}): Express {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: '1.0.1' })
  })

  app.post('/v1/chat/completions', makeChatHandler(options.upstreamFactory))

  return app
}
