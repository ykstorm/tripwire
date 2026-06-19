// POST /v1/chat/completions — OpenAI-compatible guarded proxy handler.
//
// Forwards the caller's request to OpenAI using the caller's Bearer token,
// streams chunks back as SSE, and runs each token through Tripwire's
// streaming guard. On a hard-abort rule trip it writes a `rule_trip` SSE
// event and closes the connection mid-stream.

import type { Request, Response } from 'express'
import OpenAI from 'openai'
import { createStreamingGuard, type CustomPattern } from '../../streaming/index.js'
import { initSSE, writeSSE, writeDone } from '../lib/sse.js'
import { logRequest, logSoft } from '../lib/logging.js'

/**
 * Minimal shape we depend on from the upstream client: an async-iterable of
 * chat-completion chunks. Lets tests inject a mock without a real key.
 */
export interface UpstreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>
}
export interface UpstreamClient {
  chat: {
    completions: {
      create(body: Record<string, unknown>): Promise<AsyncIterable<UpstreamChunk>>
    }
  }
}
export type UpstreamFactory = (apiKey: string) => UpstreamClient

/** Default factory: the real OpenAI SDK. */
export const defaultUpstreamFactory: UpstreamFactory = (apiKey: string) =>
  new OpenAI({ apiKey }) as unknown as UpstreamClient

/** Custom abort/observe patterns parsed from the environment (optional). */
export function getPatternsFromEnv(): CustomPattern[] {
  const raw = process.env.TRIPWIRE_CUSTOM_PATTERNS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Array<{ source: string; flags?: string; label: string; mode: 'abort' | 'observe' }>
    return parsed.map((p) => ({
      pattern: new RegExp(p.source, p.flags ?? 'i'),
      label: p.label,
      mode: p.mode,
    }))
  } catch {
    return []
  }
}

export function makeChatHandler(upstreamFactory: UpstreamFactory = defaultUpstreamFactory) {
  return async function chatHandler(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now()
    const model = (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).model : undefined) as string | undefined

    // --- Auth: caller supplies their own OpenAI key as a Bearer token. ---
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
      res.status(401).json({ error: 'missing_auth' })
      return
    }
    const apiKey = auth.slice(7).trim()

    // --- Open the upstream stream. Upstream failure => 502. ---
    let upstream: AsyncIterable<UpstreamChunk>
    try {
      const client = upstreamFactory(apiKey)
      upstream = await client.chat.completions.create({ ...req.body, stream: true })
    } catch (err) {
      res.status(502).json({ error: 'upstream_failure', detail: String(err) })
      return
    }

    // --- Stream back through the guard. ---
    let tokensStreamed = 0
    let aborted = false
    let firedRule: string | undefined

    const guard = createStreamingGuard({
      patterns: getPatternsFromEnv(),
      onAbort: (violation, pattern) => {
        aborted = true
        firedRule = pattern
        // Emit the rule_trip event and close the connection mid-stream.
        writeSSE(res, { error: 'rule_trip', violation, rule: pattern, tokens_streamed: tokensStreamed })
        res.end()
        throw new Error('aborted')
      },
      onViolate: (violation) => {
        logSoft(violation)
      },
    })

    initSSE(res)

    try {
      for await (const chunk of upstream) {
        const content = chunk.choices?.[0]?.delta?.content ?? ''
        // Run the guard BEFORE forwarding so a banned token is never delivered.
        guard.onChunk(content)
        writeSSE(res, chunk)
        tokensStreamed++
      }
      writeDone(res)
      res.end()
    } catch (err) {
      if ((err as Error).message !== 'aborted') {
        // Upstream broke mid-stream. If we haven't sent headers we can still 502;
        // otherwise surface an SSE error event and close.
        if (!res.headersSent) {
          res.status(502).json({ error: 'upstream_failure', detail: String(err) })
        } else {
          writeSSE(res, { error: 'upstream_failure', detail: String(err) })
          res.end()
        }
      }
    } finally {
      logRequest({
        ts: new Date(startedAt).toISOString(),
        route: '/v1/chat/completions',
        model,
        latencyMs: Date.now() - startedAt,
        tokensStreamed,
        aborted,
        rule: firedRule,
        status: aborted ? 200 : res.statusCode,
      })
    }
  }
}

/** Default handler wired to the real OpenAI SDK. */
export const chatHandler = makeChatHandler()
