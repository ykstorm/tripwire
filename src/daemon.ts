// Tripwire HTTP daemon — boots the OpenAI-compatible guarded proxy.
//
// Exposes:
//   GET  /healthz                 → { ok: true, version }
//   POST /v1/chat/completions     → guarded streaming proxy to OpenAI
//
// Config via env: PORT (default 8080).

import { createProxyServer } from './proxy/server.js'

const port = parseInt(process.env.PORT ?? '8080', 10)

createProxyServer().listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`tripwire daemon listening on :${port}`)
})
