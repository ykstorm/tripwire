// SSE helpers for the OpenAI-compatible proxy.
//
// Server-Sent Events framing: each event is `data: <payload>\n\n`, and the
// OpenAI streaming convention ends the stream with the sentinel `data: [DONE]`.

import type { Response } from 'express'

/** Write the SSE response headers (idempotent — only flushes once). */
export function initSSE(res: Response): void {
  if (res.headersSent) return
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
}

/** Serialize and write a single SSE data event. */
export function writeSSE(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** Write the terminal `[DONE]` sentinel. */
export function writeDone(res: Response): void {
  res.write('data: [DONE]\n\n')
}
