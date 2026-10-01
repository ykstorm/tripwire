// POST /v1/chat/completions — OpenAI-compatible guarded proxy handler.
//
// Forwards the caller's request to the pinned upstream using the caller's Bearer
// token, runs every streamed delta field through the hold-back guard, and
// forwards only the text the guard releases (synthesized as OpenAI delta chunks).
// On a hard-abort trip it emits a `rule_trip` SSE event and closes the stream.

import { timingSafeEqual } from 'crypto'
import type { Request, Response } from 'express'
import OpenAI from 'openai'
import {
  createStreamingGuard,
  GuardAbortError,
  ChunkTooLargeError,
  type StreamingGuard,
} from '../../streaming/index.js'
import { initSSE, writeSSE, writeDone } from '../lib/sse.js'
import { logRequest, logSoft } from '../lib/logging.js'
import { redact } from '../lib/redact.js'
import type { ProxyConfig } from '../config.js'

interface Delta {
  role?: string
  content?: string | null
  refusal?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
  function_call?: { name?: string; arguments?: string }
}
interface Choice {
  index?: number
  delta?: Delta
  finish_reason?: string | null
}
export interface UpstreamChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  system_fingerprint?: string
  choices?: Choice[]
}
export interface UpstreamClient {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ): Promise<AsyncIterable<UpstreamChunk>>
    }
  }
}
export type UpstreamFactory = (apiKey: string, baseURL: string) => UpstreamClient

/** Default factory: the real OpenAI SDK, pinned to the configured upstream. */
export const defaultUpstreamFactory: UpstreamFactory = (apiKey, baseURL) =>
  new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 60_000 }) as unknown as UpstreamClient

class BadRequestError extends Error {}
class UnauthorizedError extends Error {}
class StreamTooLargeError extends Error {
  constructor(limit: number) {
    super(`STREAM_TOO_LARGE: stream exceeded ${limit} characters`)
    this.name = 'StreamTooLargeError'
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Validate the caller's auth. Returns the upstream API key. */
function authenticate(req: Request, config: ProxyConfig): string {
  if (config.proxyToken) {
    const provided = String(req.headers['x-tripwire-token'] ?? '')
    if (!timingSafeEqualStr(provided, config.proxyToken)) {
      throw new UnauthorizedError('invalid proxy token')
    }
  }
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
    throw new UnauthorizedError('missing_auth')
  }
  return auth.slice(7).trim()
}

/** Validate + sanitize the request body before it reaches the upstream. */
function validateBody(raw: unknown, config: ProxyConfig): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError('body must be a JSON object')
  }
  const body = { ...(raw as Record<string, unknown>) }
  if (!Array.isArray(body.messages)) {
    throw new BadRequestError('messages must be an array')
  }
  if (typeof body.model !== 'string' || body.model.length === 0 || body.model.length > 200) {
    throw new BadRequestError('model must be a string of 1-200 characters')
  }
  if (body.n !== undefined && body.n !== null) {
    const n = Number(body.n)
    if (!Number.isInteger(n) || n !== 1) {
      throw new BadRequestError('n must be 1 — the guarded proxy does not support multiple choices')
    }
  }
  const cap = config.defaultMaxTokens
  const mt = body.max_tokens
  if (typeof mt !== 'number' || !Number.isFinite(mt) || mt <= 0 || mt > cap) {
    body.max_tokens = cap
  }
  delete body.tripwire
  body.stream = true
  return body
}

function auxText(delta: Delta): string {
  const parts: string[] = []
  if (typeof delta.refusal === 'string') parts.push(delta.refusal)
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (typeof tc.function?.arguments === 'string') parts.push(tc.function.arguments)
    }
  }
  if (typeof delta.function_call?.arguments === 'string') parts.push(delta.function_call.arguments)
  return parts.join('\n')
}

function passthroughDelta(delta: Delta): Delta {
  const out: Delta = {}
  if (delta.role) out.role = delta.role
  if (Array.isArray(delta.tool_calls)) out.tool_calls = delta.tool_calls
  if (delta.function_call) out.function_call = delta.function_call
  if (typeof delta.refusal === 'string') out.refusal = delta.refusal
  return out
}

export function makeChatHandler(
  config: ProxyConfig,
  upstreamFactory: UpstreamFactory = defaultUpstreamFactory
) {
  return async function chatHandler(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now()
    let model: string | undefined
    let tokensStreamed = 0
    let aborted = false
    let firedRule: string | undefined

    // --- Auth + body validation (before any SSE headers). ---
    let apiKey: string
    let body: Record<string, unknown>
    try {
      apiKey = authenticate(req, config)
      body = validateBody(req.body, config)
      model = body.model as string
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        res.status(401).json({ error: 'missing_auth' })
      } else {
        res.status(400).json({ error: 'invalid_request', detail: (err as Error).message })
      }
      return
    }

    const ac = new AbortController()
    res.on('close', () => ac.abort())
    const timer = setTimeout(() => ac.abort(), config.maxStreamMs)
    ;(timer as { unref?: () => void }).unref?.()

    // --- Open the upstream stream. ---
    let upstream: AsyncIterable<UpstreamChunk>
    try {
      const client = upstreamFactory(apiKey, config.upstreamUrl)
      upstream = await client.chat.completions.create(body, { signal: ac.signal })
    } catch (err) {
      clearTimeout(timer)
      const status = (err as { status?: number }).status
      logRequest({
        ts: new Date(startedAt).toISOString(),
        route: '/v1/chat/completions',
        model,
        latencyMs: Date.now() - startedAt,
        tokensStreamed: 0,
        aborted: false,
        status: 502,
        detail: redact(String((err as Error).message ?? err)),
      })
      res.status(502).json({ error: 'upstream_failure', upstream_status: status })
      return
    }

    // --- Stream through the guard. One guard per choice for content + aux. ---
    const contentGuards = new Map<number, StreamingGuard>()
    const auxGuards = new Map<number, StreamingGuard>()
    const firedLabels = new Set<string>()
    let contentChars = 0
    let errorDetail: string | undefined

    const onViolate = (violation: string, label: string): void => {
      if (firedLabels.has(label)) return
      firedLabels.add(label)
      logSoft(violation)
    }
    const makeGuard = (): StreamingGuard =>
      createStreamingGuard({ holdback: config.holdback, patterns: config.customPatterns, onViolate })
    const guardFor = (map: Map<number, StreamingGuard>, index: number): StreamingGuard => {
      let g = map.get(index)
      if (!g) {
        g = makeGuard()
        map.set(index, g)
      }
      return g
    }

    initSSE(res)

    try {
      for await (const chunk of upstream) {
        const outChoices: Choice[] = []
        for (const choice of chunk.choices ?? []) {
          const index = choice.index ?? 0
          const delta = choice.delta ?? {}

          const aux = auxText(delta)
          if (aux) guardFor(auxGuards, index).onChunk(aux)

          const content = typeof delta.content === 'string' ? delta.content : ''
          contentChars += content.length
          if (contentChars > config.maxStreamChars) throw new StreamTooLargeError(config.maxStreamChars)

          const guard = guardFor(contentGuards, index)
          let released = guard.onChunk(content)
          if (choice.finish_reason) released += guard.flush()

          const outDelta = passthroughDelta(delta)
          if (released) outDelta.content = released
          const hasDelta = Object.keys(outDelta).length > 0
          if (hasDelta || choice.finish_reason) {
            outChoices.push({ index, delta: outDelta, finish_reason: choice.finish_reason ?? null })
          }
        }

        if (outChoices.length > 0) {
          await writeSSE(res, {
            id: chunk.id,
            object: chunk.object,
            created: chunk.created,
            model: chunk.model,
            system_fingerprint: chunk.system_fingerprint,
            choices: outChoices,
          })
          tokensStreamed++
        }
      }

      // Release any held-back tails before closing.
      for (const [index, guard] of contentGuards) {
        const tail = guard.flush()
        if (!tail) continue
        await writeSSE(res, { object: 'chat.completion.chunk', choices: [{ index, delta: { content: tail }, finish_reason: null }] })
        tokensStreamed++
      }

      await writeDone(res)
      res.end()
    } catch (err) {
      if (err instanceof GuardAbortError) {
        aborted = true
        firedRule = err.rule
        ac.abort()
        await writeSSE(res, {
          error: 'rule_trip',
          violation: err.message,
          rule: err.rule,
          tokens_streamed: tokensStreamed,
        })
        res.end()
      } else if (err instanceof StreamTooLargeError || err instanceof ChunkTooLargeError) {
        ac.abort()
        await writeSSE(res, { error: 'stream_too_large' })
        res.end()
      } else if (ac.signal.aborted) {
        // Client disconnect or stream-time limit — nothing more to send.
        res.end()
      } else if (!res.headersSent) {
        res.status(502).json({ error: 'upstream_failure' })
      } else {
        await writeSSE(res, { error: 'upstream_failure' })
        res.end()
      }
      if (!(err instanceof GuardAbortError)) {
        errorDetail = redact(String((err as Error).message ?? err))
      }
    } finally {
      clearTimeout(timer)
      logRequest({
        ts: new Date(startedAt).toISOString(),
        route: '/v1/chat/completions',
        model,
        latencyMs: Date.now() - startedAt,
        tokensStreamed,
        aborted,
        rule: firedRule,
        status: aborted ? 200 : res.statusCode,
        detail: errorDetail,
      })
    }
  }
}
