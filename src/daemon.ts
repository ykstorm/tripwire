// Tripwire HTTP daemon - boots the OpenAI-compatible guarded proxy.
//
// Exposes:
//   GET  /healthz                 -> { ok: true, version }
//   POST /v1/chat/completions     -> guarded streaming proxy to the upstream
//
// Config via env (PORT, TRIPWIRE_*). See src/proxy/config.ts.

import { startProxy } from './proxy/start.js'

startProxy()
