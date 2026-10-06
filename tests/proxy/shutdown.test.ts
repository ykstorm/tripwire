import { describe, it, expect } from 'vitest'
import http from 'http'
import { once } from 'events'
import type { AddressInfo } from 'net'
import { createProxyServer } from '../../src/proxy/server.js'
import { makeShutdownHandler } from '../../src/proxy/start.js'
import type { UpstreamChunk, UpstreamFactory } from '../../src/proxy/handlers/chat.js'
import { makeConfig, contentChunk, parseSSE, AUTH, BODY } from '../adversarial/helpers.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** An upstream that sends one token every `gapMs` and stops when aborted. */
function slowUpstream(tokens: string[], gapMs: number): UpstreamFactory {
  return () => ({
    chat: {
      completions: {
        async create(_body, opts) {
          async function* gen(): AsyncGenerator<UpstreamChunk> {
            for (const t of tokens) {
              await sleep(gapMs)
              if (opts?.signal?.aborted) return
              yield contentChunk(t)
            }
          }
          return gen()
        },
      },
    },
  })
}

/** POST a chat request on its own connection; resolves with whatever body arrived. */
function post(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        agent: false,
        headers: { ...AUTH, 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d: string) => (body += d))
        res.on('close', () => resolve(body))
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(BODY))
  })
}

function content(body: string): string {
  return parseSSE(body)
    .map((e) => (e as UpstreamChunk).choices?.[0]?.delta?.content ?? '')
    .join('')
}

async function listen(factory: UpstreamFactory): Promise<{ server: http.Server; port: number }> {
  const server = createProxyServer({ config: makeConfig(), upstreamFactory: factory }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port }
}

describe('SIGTERM handler', () => {
  it('stops taking connections, lets an open stream finish, then exits 0', async () => {
    const { server, port } = await listen(slowUpstream(['one ', 'two ', 'three ', 'four'], 60))
    let exitWith: (code: number) => void = () => {}
    const exited = new Promise<number>((r) => (exitWith = r))
    const shutdown = makeShutdownHandler(server, { graceMs: 5000, exit: (code) => exitWith(code), log: () => {} })

    const inFlight = post(port)
    await sleep(90) // the stream is open and its first token is on the way
    shutdown()

    await expect(post(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    const body = await inFlight
    expect(body).toContain('data: [DONE]')
    expect(content(body)).toBe('one two three four')
    expect(await exited).toBe(0)
  })

  it('closes streams still open after the grace period and exits 1', async () => {
    const { server, port } = await listen(slowUpstream(Array.from({ length: 50 }, (_, i) => `t${i} `), 100))
    const codes: number[] = []
    let exitWith: (code: number) => void = () => {}
    const exited = new Promise<number>((r) => (exitWith = r))
    const shutdown = makeShutdownHandler(server, {
      graceMs: 200,
      exit: (code) => {
        codes.push(code)
        exitWith(code)
      },
      log: () => {},
    })

    const inFlight = post(port)
    await sleep(150)
    const t0 = Date.now()
    shutdown()
    expect(await exited).toBe(1)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(await inFlight).not.toContain('data: [DONE]')
    await sleep(50)
    expect(codes).toEqual([1]) // close() completing afterwards does not exit a second time
  })
})
