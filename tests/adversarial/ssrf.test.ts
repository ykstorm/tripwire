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

describe('private host classification at every range edge', () => {
  const strict = { allowInsecure: false, allowPrivate: false }

  /** True when the upstream is refused for being private, false when it is accepted. */
  function refusedAsPrivate(host: string): boolean {
    try {
      validateUpstreamUrl(`https://${host}/v1`, strict)
      return false
    } catch (err) {
      if (err instanceof ConfigError && err.message.includes('is private/link-local/loopback')) return true
      throw err
    }
  }

  const PRIVATE: Array<[string, string]> = [
    ['10.0.0.0', 'start of 10/8'],
    ['10.255.255.255', 'end of 10/8'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'end of 127/8'],
    ['0.0.0.0', 'this host'],
    ['0.1.2.3', 'inside 0/8'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.0', 'start of 172.16/12'],
    ['172.31.255.255', 'end of 172.16/12'],
    ['192.168.0.0', 'start of 192.168/16'],
    ['192.168.255.255', 'end of 192.168/16'],
    ['100.64.0.0', 'start of CGNAT 100.64/10'],
    ['100.127.255.255', 'end of CGNAT 100.64/10'],
    ['2130706433', '127.0.0.1 written as one decimal number'],
    ['0x7f.1', '127.0.0.1 in hex shorthand'],
    ['0251.0376.0251.0376', '169.254.169.254 in octal'],
    ['localhost', 'localhost'],
    ['LOCALHOST', 'localhost in capitals'],
    ['api.localhost', 'a subdomain of localhost'],
    ['localhost.', 'localhost with a trailing dot'],
    ['localhost..', 'localhost with two trailing dots'],
    ['[::1]', 'IPv6 loopback'],
    ['[0:0:0:0:0:0:0:1]', 'IPv6 loopback in long form'],
    ['[::]', 'IPv6 unspecified'],
    ['[fe80::1]', 'start of fe80::/10'],
    ['[febf:ffff::1]', 'end of fe80::/10'],
    ['[fc00::1]', 'start of fc00::/7'],
    ['[fdff:ffff::1]', 'end of fc00::/7'],
    ['[::ffff:127.0.0.1]', 'IPv4-mapped loopback, dotted'],
    ['[::ffff:7f00:1]', 'IPv4-mapped loopback, hex'],
    ['[::ffff:a9fe:a9fe]', 'IPv4-mapped metadata, hex'],
    ['[::ffff:0.0.0.0]', 'IPv4-mapped this host'],
  ]

  const PUBLIC: Array<[string, string]> = [
    ['9.255.255.255', 'just below 10/8'],
    ['11.0.0.0', 'just above 10/8'],
    ['128.0.0.1', 'just above 127/8'],
    ['1.0.0.1', 'just above 0/8'],
    ['169.253.255.255', 'just below 169.254/16'],
    ['169.255.0.1', 'just above 169.254/16'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['172.32.0.0', 'just above 172.16/12'],
    ['192.167.255.255', 'just below 192.168/16'],
    ['192.169.0.0', 'just above 192.168/16'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.0', 'just above CGNAT'],
    ['8.8.8.8', 'public resolver'],
    ['api.openai.com', 'public hostname'],
    ['api.openai.com.', 'public hostname with a trailing dot'],
    ['localhost.example.com', 'localhost as the left-most label only'],
    ['mylocalhost', 'a name that only ends in the letters localhost'],
    ['fdic.gov', 'hostname that starts like a ULA prefix'],
    ['fe80.example.com', 'hostname that starts like a link-local prefix'],
    ['[2606:4700::1111]', 'public IPv6'],
    ['[fe7f::1]', 'just below fe80::/10'],
    ['[fec0::1]', 'just above fe80::/10'],
    ['[fbff::1]', 'just below fc00::/7'],
    ['[fe00::1]', 'just above fc00::/7'],
    ['[::ffff:8.8.8.8]', 'IPv4-mapped public address'],
    ['[::2]', 'empty first group, read as 0'],
  ]

  it.each(PRIVATE)('refuses %s (%s)', (host) => {
    expect(refusedAsPrivate(host)).toBe(true)
  })

  it.each(PUBLIC)('accepts %s (%s)', (host) => {
    expect(refusedAsPrivate(host)).toBe(false)
  })

  it('accepts every private host once private upstreams are allowed', () => {
    for (const [host] of PRIVATE) {
      expect(() => validateUpstreamUrl(`https://${host}/v1`, { allowInsecure: false, allowPrivate: true }), host).not.toThrow()
    }
  })
})
