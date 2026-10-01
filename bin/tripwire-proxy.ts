#!/usr/bin/env node
// CLI entrypoint for the Tripwire OpenAI-compatible proxy.
//
//   tripwire-proxy            # listens on :8080 (or $PORT)
//
// Streams upstream responses through Tripwire's rule engine and aborts
// mid-stream on a rule trip.

import { startProxy } from '../src/proxy/start.js'

startProxy()
