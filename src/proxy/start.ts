// Shared boot path for the daemon and the CLI entrypoint.
//
// Loads config fail-fast (a bad upstream URL or a catastrophic custom pattern
// stops the process here, not mid-request), warns if the proxy is unauthenticated,
// sets conservative socket timeouts against slow-client attacks, and drains
// open streams on SIGTERM instead of cutting them off.

import type { Server } from 'http'
import { createProxyServer } from './server.js'
import { loadConfig, ConfigError } from './config.js'

interface ShutdownOptions {
  /** How long open streams get to finish before they are closed. */
  graceMs: number
  exit: (code: number) => void
  log?: (message: string) => void
}

/**
 * The SIGTERM handler. It stops accepting connections, lets the streams that
 * are already open finish, and exits 0 once the last connection has closed.
 * Every stream already ends by TRIPWIRE_MAX_STREAM_MS, so that is the grace
 * period; anything still open after it is closed and the exit code is 1.
 */
export function makeShutdownHandler(server: Server, options: ShutdownOptions): () => void {
  const { graceMs, exit, log = (message: string) => console.log(message) } = options
  let started = false
  return () => {
    if (started) return
    started = true
    log(`[tripwire] SIGTERM: no new connections; waiting up to ${graceMs}ms for open streams`)

    let finished = false
    const finish = (code: number): void => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearInterval(sweep)
      exit(code)
    }
    const deadline = setTimeout(() => {
      log(`[tripwire] streams still open after ${graceMs}ms; closing them`)
      server.closeAllConnections?.()
      finish(1)
    }, graceMs)
    // A keep-alive connection whose stream has ended would hold close() open;
    // drop such connections as they go idle.
    const sweep = setInterval(() => server.closeIdleConnections?.(), 250)
    sweep.unref()

    server.close(() => finish(0))
    server.closeIdleConnections?.()
  }
}

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
      '[tripwire] TRIPWIRE_PROXY_TOKEN is not set - anyone who can reach this port can use the proxy'
    )
  }

  const port = parseInt(process.env.PORT ?? '8080', 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[tripwire] PORT must be a whole number from 0 to 65535, got ${JSON.stringify(process.env.PORT)}`)
    process.exit(1)
  }
  const server = createProxyServer({ config }).listen(port, () => {
    console.log(`tripwire proxy listening on :${port}`)
  })

  server.headersTimeout = 65_000
  server.keepAliveTimeout = 60_000
  server.requestTimeout = config.maxStreamMs + 30_000

  process.once(
    'SIGTERM',
    makeShutdownHandler(server, { graceMs: config.maxStreamMs, exit: (code) => process.exit(code) })
  )

  return server
}
