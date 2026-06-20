#!/usr/bin/env node
// CLI entrypoint for the Tripwire OpenAI-compatible proxy.
//
//   tripwire-proxy            # listens on :8080 (or $PORT)
//
// Streams OpenAI responses through Tripwire's rule engine and aborts
// mid-stream on a rule trip.

import { createProxyServer } from '../src/proxy/server.js'

const port = parseInt(process.env.PORT ?? '8080', 10)

createProxyServer().listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`tripwire-proxy listening on :${port}`)
})
