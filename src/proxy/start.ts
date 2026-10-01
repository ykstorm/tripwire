// Shared boot path for the daemon and the CLI entrypoint.
//
// Loads config fail-fast (a bad upstream URL or a catastrophic custom pattern
// stops the process here, not mid-request), warns if the proxy is unauthenticated,
// and sets conservative socket timeouts against slow-client attacks.

import type { Server } from 'http'
import { createProxyServer } from './server.js'
import { loadConfig, ConfigError } from './config.js'

export function startProxy(): Server {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[tripwire] configuration error: ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  if (!config.proxyToken) {
    console.warn(
      '[tripwire] TRIPWIRE_PROXY_TOKEN is not set — anyone who can reach this port can use the proxy'
    )
  }

  const port = parseInt(process.env.PORT ?? '8080', 10)
  const server = createProxyServer({ config }).listen(port, () => {
    console.log(`tripwire proxy listening on :${port}`)
  })

  server.headersTimeout = 65_000
  server.keepAliveTimeout = 60_000
  server.requestTimeout = config.maxStreamMs + 30_000

  return server
}
