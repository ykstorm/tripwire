// SSE helpers for the OpenAI-compatible proxy.
//
// Each event is `data: <payload>\n\n`; the stream ends with the sentinel
// `data: [DONE]`. Writes honor backpressure (await drain) and never touch a
// response that has already ended or been destroyed.

import type { Response } from 'express'

/** Write the SSE response headers (idempotent - only flushes once). */
export function initSSE(res: Response): void {
  if (res.headersSent) return
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
}

/** Write a frame, awaiting drain if the socket buffer is full. Resolves (does
 *  nothing) if the response is already finished or the client has gone away. */
async function safeWrite(res: Response, data: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return
  const ok = res.write(data)
  if (ok) return
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      res.off('error', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
    res.once('error', done)
  })
}

/** Serialize and write a single SSE data event. */
export function writeSSE(res: Response, payload: unknown): Promise<void> {
  return safeWrite(res, `data: ${JSON.stringify(payload)}\n\n`)
}

/** Write the terminal `[DONE]` sentinel. */
export function writeDone(res: Response): Promise<void> {
  return safeWrite(res, 'data: [DONE]\n\n')
}
