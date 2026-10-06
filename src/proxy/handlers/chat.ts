// POST /v1/chat/completions - OpenAI-compatible guarded proxy handler.
//
// Forwards the caller's request to the pinned upstream using the caller's Bearer
// token, runs every streamed delta field through the hold-back guard, and
// forwards only the text the guards release, for content and for tool-call,
// refusal and function-call deltas alike (synthesized as OpenAI delta chunks).
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

const defaultUpstreamFactory: UpstreamFactory = (apiKey, baseURL) =>
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
  // The guard works on a stream and the reply is always SSE, so a caller that
  // asked for one JSON object (stream false or left out) is told so up front
  // rather than handed SSE text it will not parse.
  if (body.stream !== true) {
    throw new BadRequestError('stream must be true - the guarded proxy only serves streaming responses')
  }
  assertSingleChoice(body.n)
  body.max_tokens = effectiveMaxTokens(body.max_tokens, config.defaultMaxTokens)
  delete body.tripwire
  return body
}

function assertSingleChoice(n: unknown): void {
  if (n !== undefined && n !== null && Number(n) !== 1) {
    throw new BadRequestError('n must be 1 - the guarded proxy does not support multiple choices')
  }
}

/** The caller's max_tokens when it is a positive finite number within the cap, otherwise the cap. */
function effectiveMaxTokens(requested: unknown, cap: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0 || requested > cap) {
    return cap
  }
  return requested
}

/**
 * Authenticate and validate before any SSE headers are sent, so a rejection is
 * still a plain JSON 401/400. Returns undefined once it has replied.
 */
function acceptRequest(
  req: Request,
  res: Response,
  config: ProxyConfig
): { apiKey: string; body: Record<string, unknown> } | undefined {
  try {
    const apiKey = authenticate(req, config)
    return { apiKey, body: validateBody(req.body, config) }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: 'missing_auth' })
    } else {
      res.status(400).json({ error: 'invalid_request', detail: (err as Error).message })
    }
    return undefined
  }
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

/** A non-content delta waiting for the aux guard to release the text it carries. */
interface HeldAux {
  delta: Delta
  chars: number
}

/** Per choice index: deltas held back until the aux guard releases their text. */
interface AuxQueue {
  held: HeldAux[]
  releasedChars: number
  emittedChars: number
}

/** Guard state for one request: one content guard and one aux guard per choice index. */
interface ScanState {
  contentGuards: Map<number, StreamingGuard>
  auxGuards: Map<number, StreamingGuard>
  auxQueues: Map<number, AuxQueue>
  guardFor: (map: Map<number, StreamingGuard>, index: number) => StreamingGuard
  contentChars: number
  maxStreamChars: number
}

function createScanState(config: ProxyConfig): ScanState {
  const firedLabels = new Set<string>()
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
  return {
    contentGuards: new Map(),
    auxGuards: new Map(),
    auxQueues: new Map(),
    guardFor,
    contentChars: 0,
    maxStreamChars: config.maxStreamChars,
  }
}

/**
 * Tool-call arguments, refusals and function-call arguments get the same
 * hold-back as content: a delta is forwarded only once the aux guard has
 * released all the text up to and including it. Deltas are atomic, so one
 * that straddles the release boundary waits for the next release. On a trip
 * the guard throws and whatever is still held is never sent.
 */
function releaseAux(delta: Delta, aux: string, finished: boolean, index: number, scan: ScanState): Delta[] {
  const guard = scan.guardFor(scan.auxGuards, index)
  let queue = scan.auxQueues.get(index)
  if (!queue) {
    queue = { held: [], releasedChars: 0, emittedChars: 0 }
    scan.auxQueues.set(index, queue)
  }
  let released = guard.onChunk(aux)
  if (finished) released += guard.flush()
  queue.releasedChars += released.length
  queue.held.push({ delta: auxDelta(delta), chars: aux.length })
  const out: Delta[] = []
  while (queue.held.length > 0 && queue.emittedChars + queue.held[0].chars <= queue.releasedChars) {
    const next = queue.held.shift() as HeldAux
    queue.emittedChars += next.chars
    out.push(next.delta)
  }
  return out
}

function auxDelta(delta: Delta): Delta {
  const out: Delta = {}
  if (Array.isArray(delta.tool_calls)) out.tool_calls = delta.tool_calls
  if (delta.function_call) out.function_call = delta.function_call
  if (typeof delta.refusal === 'string') out.refusal = delta.refusal
  return out
}

/** Fold released aux deltas into one: clients accumulate these fields by index or by concatenation. */
function mergeAux(target: Delta, parts: Delta[]): void {
  for (const part of parts) {
    if (part.tool_calls) target.tool_calls = [...(target.tool_calls ?? []), ...part.tool_calls]
    if (part.refusal !== undefined) target.refusal = (target.refusal ?? '') + part.refusal
    if (part.function_call) {
      const prev = target.function_call ?? {}
      target.function_call = {
        ...prev,
        ...(part.function_call.name !== undefined ? { name: part.function_call.name } : {}),
        arguments: (prev.arguments ?? '') + (part.function_call.arguments ?? ''),
      }
    }
  }
}

/** Run one upstream choice through its guards and return the choice to forward, if any. */
function scanChoice(choice: Choice, scan: ScanState): Choice | undefined {
  const index = choice.index ?? 0
  const delta = choice.delta ?? {}
  const finished = Boolean(choice.finish_reason)

  const aux = auxText(delta)
  const auxOut = aux ? releaseAux(delta, aux, finished, index, scan) : []
  // A finish with nothing new to scan still releases whatever the aux guard holds.
  if (!aux && finished && scan.auxQueues.get(index)?.held.length) auxOut.push(...releaseAux({}, '', true, index, scan))

  const content = typeof delta.content === 'string' ? delta.content : ''
  scan.contentChars += content.length
  if (scan.contentChars > scan.maxStreamChars) throw new StreamTooLargeError(scan.maxStreamChars)

  const guard = scan.guardFor(scan.contentGuards, index)
  let released = guard.onChunk(content)
  if (finished) released += guard.flush()

  return forwardedChoice(index, delta, released, auxOut, choice.finish_reason)
}

function forwardedChoice(
  index: number,
  delta: Delta,
  released: string,
  auxOut: Delta[],
  finishReason: string | null | undefined
): Choice | undefined {
  const outDelta: Delta = {}
  if (delta.role) outDelta.role = delta.role
  if (released) outDelta.content = released
  mergeAux(outDelta, auxOut)
  const hasDelta = Object.keys(outDelta).length > 0
  if (hasDelta || finishReason) return { index, delta: outDelta, finish_reason: finishReason ?? null }
  return undefined
}

/** How the stream ended, for the rule_trip event and the request log line. */
interface StreamOutcome {
  tokensStreamed: number
  aborted: boolean
  rule?: string
  detail?: string
}

async function streamGuarded(
  upstream: AsyncIterable<UpstreamChunk>,
  res: Response,
  config: ProxyConfig,
  outcome: StreamOutcome
): Promise<void> {
  const scan = createScanState(config)
  for await (const chunk of upstream) {
    const outChoices: Choice[] = []
    for (const choice of chunk.choices ?? []) {
      const out = scanChoice(choice, scan)
      if (out) outChoices.push(out)
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
      outcome.tokensStreamed++
    }
  }

  // Release any held-back tails before closing.
  for (const [index, guard] of scan.contentGuards) {
    const tail = guard.flush()
    if (!tail) continue
    await writeSSE(res, { object: 'chat.completion.chunk', choices: [{ index, delta: { content: tail }, finish_reason: null }] })
    outcome.tokensStreamed++
  }

  await writeDone(res)
  res.end()
}

async function endStreamOnError(
  err: unknown,
  res: Response,
  ac: AbortController,
  outcome: StreamOutcome
): Promise<void> {
  if (err instanceof GuardAbortError) {
    outcome.aborted = true
    outcome.rule = err.rule
    ac.abort()
    await writeSSE(res, {
      error: 'rule_trip',
      violation: err.message,
      rule: err.rule,
      tokens_streamed: outcome.tokensStreamed,
    })
    res.end()
  } else if (err instanceof StreamTooLargeError || err instanceof ChunkTooLargeError) {
    ac.abort()
    await writeSSE(res, { error: 'stream_too_large' })
    res.end()
  } else if (ac.signal.aborted) {
    // Client disconnect or stream-time limit - nothing more to send.
    res.end()
  } else if (!res.headersSent) {
    res.status(502).json(upstreamFailureBody(err))
  } else {
    await writeSSE(res, upstreamFailureBody(err))
    res.end()
  }
  if (!(err instanceof GuardAbortError)) {
    outcome.detail = redactedDetail(err)
  }
}

/**
 * What a client is told when the upstream fails, both as the 502 body and as the
 * last SSE event of a stream that breaks halfway. The upstream's own message
 * stays in the log. A wrong key reaches the upstream and comes back as a 401;
 * the proxy keeps answering 502 (it is the upstream that refused), but says so.
 */
function upstreamFailureBody(err: unknown): { error: string; upstream_status: number | null; message: string } {
  const status = (err as { status?: unknown } | null | undefined)?.status
  const upstreamStatus = typeof status === 'number' ? status : null
  return {
    error: 'upstream_failure',
    upstream_status: upstreamStatus,
    message:
      upstreamStatus === 401
        ? 'the upstream rejected the credential; check the API key sent as the Bearer token'
        : 'the upstream request failed',
  }
}

/** Log a failed upstream open and answer 502. The redacted detail goes to the log only. */
function replyUpstreamFailure(err: unknown, res: Response, startedAt: number, model: string): void {
  logRequest({
    ts: new Date(startedAt).toISOString(),
    route: '/v1/chat/completions',
    model,
    latencyMs: Date.now() - startedAt,
    tokensStreamed: 0,
    aborted: false,
    status: 502,
    detail: redactedDetail(err),
  })
  res.status(502).json(upstreamFailureBody(err))
}

function redactedDetail(err: unknown): string {
  return redact(String((err as Error).message ?? err))
}

export function makeChatHandler(
  config: ProxyConfig,
  upstreamFactory: UpstreamFactory = defaultUpstreamFactory
) {
  return async function chatHandler(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now()
    const accepted = acceptRequest(req, res, config)
    if (!accepted) return
    const { apiKey, body } = accepted
    const model = body.model as string

    const ac = new AbortController()
    res.on('close', () => ac.abort())
    const timer = setTimeout(() => ac.abort(), config.maxStreamMs)
    ;(timer as { unref?: () => void }).unref?.()

    let upstream: AsyncIterable<UpstreamChunk>
    try {
      const client = upstreamFactory(apiKey, config.upstreamUrl)
      upstream = await client.chat.completions.create(body, { signal: ac.signal })
    } catch (err) {
      clearTimeout(timer)
      replyUpstreamFailure(err, res, startedAt, model)
      return
    }

    const outcome: StreamOutcome = { tokensStreamed: 0, aborted: false }
    initSSE(res)
    try {
      await streamGuarded(upstream, res, config, outcome)
    } catch (err) {
      await endStreamOnError(err, res, ac, outcome)
    } finally {
      clearTimeout(timer)
      logRequest({
        ts: new Date(startedAt).toISOString(),
        route: '/v1/chat/completions',
        model,
        latencyMs: Date.now() - startedAt,
        tokensStreamed: outcome.tokensStreamed,
        aborted: outcome.aborted,
        rule: outcome.rule,
        status: outcome.aborted ? 200 : res.statusCode,
        detail: outcome.detail,
      })
    }
  }
}
