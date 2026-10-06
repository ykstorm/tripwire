import { describe, it, expect } from 'vitest'
import { validateUpstreamUrl, loadConfig, ConfigError } from '../../src/proxy/config.js'

describe('upstream URL pinning (SSRF guard)', () => {
  const strict = { allowInsecure: false, allowPrivate: false }

  it('rejects the cloud metadata address', () => {
    expect(() => validateUpstreamUrl('http://169.254.169.254/latest/meta-data', strict)).toThrow(ConfigError)
    expect(() => validateUpstreamUrl('https://169.254.169.254/', strict)).toThrow(ConfigError)
  })

  it('rejects a loopback upstream unless both allow-flags are set', () => {
    expect(() => validateUpstreamUrl('http://127.0.0.1:11434/v1', strict)).toThrow(ConfigError)
    expect(() => validateUpstreamUrl('http://127.0.0.1:11434/v1', { allowInsecure: true, allowPrivate: false })).toThrow(ConfigError)
    expect(() =>
      validateUpstreamUrl('http://127.0.0.1:11434/v1', { allowInsecure: true, allowPrivate: true })
    ).not.toThrow()
  })

  it('rejects private ranges, localhost, and IPv6 loopback', () => {
    for (const host of ['https://10.0.0.5', 'https://192.168.1.1', 'https://172.16.0.1', 'https://localhost', 'https://[::1]']) {
      expect(() => validateUpstreamUrl(host, strict)).toThrow(ConfigError)
    }
  })

  it('rejects localhost written with a trailing dot', () => {
    for (const host of ['https://localhost./v1', 'https://LOCALHOST./v1', 'https://api.localhost./v1']) {
      expect(() => validateUpstreamUrl(host, strict), host).toThrow(ConfigError)
    }
    expect(() => validateUpstreamUrl('https://api.openai.com./v1', strict)).not.toThrow()
  })

  it('rejects IPv4-mapped IPv6 spellings of private and metadata addresses', () => {
    for (const host of ['[::ffff:169.254.169.254]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[fe90::1]', '[fdab::1]']) {
      expect(() => validateUpstreamUrl(`https://${host}/v1`, strict), host).toThrow(ConfigError)
    }
    expect(() => validateUpstreamUrl('https://[2606:4700::1111]/v1', strict)).not.toThrow()
  })

  it('does not mistake public hostnames that start like IPv6 prefixes for private addresses', () => {
    expect(() => validateUpstreamUrl('https://fdic.gov/v1', strict)).not.toThrow()
    expect(() => validateUpstreamUrl('https://fe80.example.com/v1', strict)).not.toThrow()
    expect(() => validateUpstreamUrl('https://[fd00::1]/v1', strict)).toThrow(ConfigError)
    expect(() => validateUpstreamUrl('https://[fe80::1]/v1', strict)).toThrow(ConfigError)
  })

  it('requires https unless insecure is allowed', () => {
    expect(() => validateUpstreamUrl('http://api.openai.com/v1', strict)).toThrow(ConfigError)
    expect(() => validateUpstreamUrl('https://api.openai.com/v1', strict)).not.toThrow()
  })

  it('loadConfig exits-path (throws ConfigError) on a metadata upstream', () => {
    expect(() => loadConfig({ TRIPWIRE_UPSTREAM_URL: 'http://169.254.169.254' } as NodeJS.ProcessEnv)).toThrow(ConfigError)
  })

  it('accepts the default public upstream', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).upstreamUrl).toBe('https://api.openai.com/v1')
  })
})
