import { describe, it, expect, afterEach, vi } from 'vitest'
import { once } from 'events'
import request from 'supertest'
import { createProxyServer } from '../../src/proxy/server.js'
import { loadConfig, parseBuiltinRules, ConfigError } from '../../src/proxy/config.js'
import { noRuleWarning, startProxy } from '../../src/proxy/start.js'
import { BUILTIN_RULE_LABELS } from '../../src/streaming/index.js'
import type { UpstreamChunk } from '../../src/proxy/handlers/chat.js'
import { mockUpstream, contentChunk, parseSSE, AUTH, BODY } from '../adversarial/helpers.js'

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv

const LAUNCH_RULE = JSON.stringify([{ source: 'launch-codes', label: 'CUSTOM_SECRET', mode: 'abort' }])

/** Send one request through a proxy built from `vars` and return the trip event, if any, with the raw body. */
async function run(vars: Record<string, string>, chunks: UpstreamChunk[]) {
  const app = createProxyServer({ config: loadConfig(env(vars)), upstreamFactory: mockUpstream(chunks) })
  const res = await request(app).post('/v1/chat/completions').set(AUTH).send(BODY)
  const trip = parseSSE(res.text).find((e) => (e as { error?: string }).error === 'rule_trip') as
    | { rule: string }
    | undefined
  return { text: res.text, trip }
}

const phoneStream = [contentChunk('Rent is 65000-75000 a month, '), contentChunk('call 9876543210 to book.')]

describe('TRIPWIRE_BUILTIN_RULES parsing', () => {
  it('reads unset, empty and "all" as every built-in rule', () => {
    expect(parseBuiltinRules(undefined)).toBe(true)
    expect(parseBuiltinRules('')).toBe(true)
    expect(parseBuiltinRules('   ')).toBe(true)
    expect(parseBuiltinRules('all')).toBe(true)
    expect(parseBuiltinRules(' ALL ')).toBe(true)
    expect(loadConfig(env({})).builtinRules).toBe(true)
  })

  it('reads "none" as no built-in rules', () => {
    expect(parseBuiltinRules('none')).toBe(false)
    expect(parseBuiltinRules(' None ')).toBe(false)
    expect(loadConfig(env({ TRIPWIRE_BUILTIN_RULES: 'none' })).builtinRules).toBe(false)
  })

  it('reads a comma list as those labels, trimmed and without repeats', () => {
    expect(parseBuiltinRules('SECRET_LEAK')).toEqual(['SECRET_LEAK'])
    expect(parseBuiltinRules(' SECRET_LEAK , NO_MARKDOWN,SECRET_LEAK ')).toEqual(['SECRET_LEAK', 'NO_MARKDOWN'])
    expect(parseBuiltinRules(BUILTIN_RULE_LABELS.join(','))).toEqual([...BUILTIN_RULE_LABELS])
    expect(loadConfig(env({ TRIPWIRE_BUILTIN_RULES: 'CONTACT_LEAK,SECRET_LEAK' })).builtinRules).toEqual([
      'CONTACT_LEAK',
      'SECRET_LEAK',
    ])
  })

  it('stops the boot on a value that is not all, none or a list of known labels', () => {
    const bad = ['SECRET_LEEK', 'secret_leak', 'SECRET_LEAK,NOPE', 'all,SECRET_LEAK', 'none,SECRET_LEAK', 'yes', '0', 'SECRET_LEAK,', ',', 'SECRET_LEAK,,NO_MARKDOWN']
    for (const value of bad) {
      expect(() => parseBuiltinRules(value), value).toThrow(ConfigError)
      expect(() => loadConfig(env({ TRIPWIRE_BUILTIN_RULES: value })), value).toThrow(ConfigError)
    }
  })

  it('names the variable and lists the valid labels in the boot error', () => {
    let message = ''
    try {
      loadConfig(env({ TRIPWIRE_BUILTIN_RULES: 'SECRET_LEEK' }))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('TRIPWIRE_BUILTIN_RULES')
    expect(message).toContain('"SECRET_LEEK"')
    for (const label of BUILTIN_RULE_LABELS) expect(message).toContain(label)
    expect(message).toContain('"all" or "none"')

    expect(() => parseBuiltinRules('SECRET_LEAK,')).toThrow(/TRIPWIRE_BUILTIN_RULES has an empty entry/)
  })
})

describe('TRIPWIRE_BUILTIN_RULES in the proxy', () => {
  it('by default a phone number in the reply trips CONTACT_LEAK', async () => {
    const { text, trip } = await run({}, phoneStream)
    expect(trip?.rule).toBe('CONTACT_LEAK')
    expect(text).not.toContain('data: [DONE]')
  })

  it('"none": the phone number and the rupee range reach the client, the custom rule still trips', async () => {
    const vars = { TRIPWIRE_BUILTIN_RULES: 'none', TRIPWIRE_CUSTOM_PATTERNS: LAUNCH_RULE }

    const clean = await run(vars, phoneStream)
    expect(clean.trip).toBeUndefined()
    expect(clean.text).toContain('data: [DONE]')
    const forwarded = (parseSSE(clean.text) as UpstreamChunk[]).map((e) => e.choices?.[0]?.delta?.content ?? '').join('')
    expect(forwarded).toBe('Rent is 65000-75000 a month, call 9876543210 to book.')

    const tripped = await run(vars, [contentChunk('Here are the '), contentChunk('launch-codes'), contentChunk(' for you')])
    expect(tripped.trip?.rule).toBe('CUSTOM_SECRET')
    expect(tripped.text).not.toContain('data: [DONE]')
  })

  it('a label list: the phone number passes and the listed SECRET_LEAK still trips', async () => {
    const vars = { TRIPWIRE_BUILTIN_RULES: 'SECRET_LEAK' }

    const clean = await run(vars, phoneStream)
    expect(clean.trip).toBeUndefined()
    expect(clean.text).toContain('data: [DONE]')

    const leaked = await run(vars, [contentChunk('your key is '), contentChunk('sk-abcd1234efgh5678ijkl9012mnop')])
    expect(leaked.trip?.rule).toBe('SECRET_LEAK')
    expect(leaked.text).not.toContain('sk-abcd')
  })

  it('"none" also applies to tool-call arguments, which have their own guard', async () => {
    const chunks: UpstreamChunk[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '98765' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '43210' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const { text, trip } = await run({ TRIPWIRE_BUILTIN_RULES: 'none' }, chunks)
    expect(trip).toBeUndefined()
    expect(text).toContain('98765')
    expect(text).toContain('43210')
    expect(text).toContain('data: [DONE]')
  })
})

describe('the warning when no rule is active', () => {
  const warnFor = (vars: Record<string, string>): string | undefined => noRuleWarning(loadConfig(env(vars)))

  it('fires when the built-in rules are off and no custom pattern is set', () => {
    const line = warnFor({ TRIPWIRE_BUILTIN_RULES: 'none' })
    expect(line).toBeDefined()
    expect(line).toContain('no rule is active')
    expect(line).toContain('TRIPWIRE_BUILTIN_RULES')
    expect(line).toContain('TRIPWIRE_CUSTOM_PATTERNS')
    expect(line).not.toContain('\n')
  })

  it('fires for an empty custom pattern list, and for an empty label list from the library option', () => {
    expect(warnFor({ TRIPWIRE_BUILTIN_RULES: 'none', TRIPWIRE_CUSTOM_PATTERNS: '[]' })).toBeDefined()
    expect(noRuleWarning({ builtinRules: false, customPatterns: [] })).toBeDefined()
    expect(noRuleWarning({ builtinRules: [], customPatterns: [] })).toBeDefined()
  })

  it('stays quiet when a custom pattern is set, even with the built-in rules off', () => {
    expect(warnFor({ TRIPWIRE_BUILTIN_RULES: 'none', TRIPWIRE_CUSTOM_PATTERNS: LAUNCH_RULE })).toBeUndefined()
    const mine = loadConfig(env({ TRIPWIRE_CUSTOM_PATTERNS: LAUNCH_RULE })).customPatterns
    expect(noRuleWarning({ builtinRules: false, customPatterns: mine })).toBeUndefined()
    expect(noRuleWarning({ builtinRules: [], customPatterns: mine })).toBeUndefined()
  })

  it('stays quiet while any built-in rule is on', () => {
    expect(warnFor({})).toBeUndefined()
    expect(warnFor({ TRIPWIRE_BUILTIN_RULES: 'all' })).toBeUndefined()
    expect(warnFor({ TRIPWIRE_BUILTIN_RULES: 'SECRET_LEAK' })).toBeUndefined()
    // An empty value means "all", as before, so the rules are active.
    expect(warnFor({ TRIPWIRE_BUILTIN_RULES: '' })).toBeUndefined()
  })
})

describe('proxy start with no rule active', () => {
  const KEYS = ['PORT', 'TRIPWIRE_BUILTIN_RULES', 'TRIPWIRE_CUSTOM_PATTERNS', 'TRIPWIRE_PROXY_TOKEN']
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const sigtermBefore = process.listeners('SIGTERM')

  afterEach(() => {
    vi.restoreAllMocks()
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    for (const l of process.listeners('SIGTERM')) {
      if (!sigtermBefore.includes(l)) process.removeListener('SIGTERM', l)
    }
  })

  /** Boot the real startProxy on a free port and return the stderr warning lines it printed. */
  async function boot(vars: Record<string, string>): Promise<{ warnings: string[]; listening: boolean }> {
    for (const k of KEYS) delete process.env[k]
    Object.assign(process.env, { PORT: '0', TRIPWIRE_PROXY_TOKEN: 'a-test-token' }, vars)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const server = startProxy()
    await once(server, 'listening')
    const listening = server.listening
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    return { warnings: warn.mock.calls.map((args) => String(args[0])), listening }
  }

  it('prints one line naming both settings, and still starts', async () => {
    const { warnings, listening } = await boot({ TRIPWIRE_BUILTIN_RULES: 'none' })
    const lines = warnings.filter((w) => w.includes('no rule is active'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('TRIPWIRE_BUILTIN_RULES')
    expect(lines[0]).toContain('TRIPWIRE_CUSTOM_PATTERNS')
    expect(lines[0]).not.toContain('\n')
    expect(listening).toBe(true)
  })

  it('prints no such line when a custom pattern is configured', async () => {
    const { warnings, listening } = await boot({ TRIPWIRE_BUILTIN_RULES: 'none', TRIPWIRE_CUSTOM_PATTERNS: LAUNCH_RULE })
    expect(warnings.filter((w) => w.includes('no rule is active'))).toEqual([])
    expect(listening).toBe(true)
  })

  it('prints no such line with the default rules', async () => {
    const { warnings } = await boot({})
    expect(warnings.filter((w) => w.includes('no rule is active'))).toEqual([])
  })
})
