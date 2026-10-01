// Secret / credential leak pattern — a hard-abort guard. Each alternative is
// anchored to a provider-specific prefix plus a minimum token length, so prose
// ("the API key is in the vault") does not trip it and every quantifier is a
// single bounded character class (linear, no catastrophic backtracking).

/**
 * Matches common leaked credentials in a token stream: modern OpenAI/Anthropic
 * `sk-…` keys (including `_`/`-` in the body), Stripe `sk_live_`/`rk_live_`,
 * GitLab `glpat-`, npm `npm_`, Slack `xapp-`/`xox[baprs]-`, AWS `AKIA…`, GitHub
 * `gh[opsur]_…`, Google `AIza…`, JWTs (`eyJ….….…`), PEM private-key headers,
 * and long `Bearer` tokens.
 */
export const SECRET_LEAK_PATTERN = new RegExp(
  [
    '(?<![A-Za-z0-9])sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}',
    '(?<![A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{20,}',
    '(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}',
    '(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}',
    '(?<![A-Za-z0-9])xapp-[A-Za-z0-9-]{10,}',
    '(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'gh[opsur]_[A-Za-z0-9]{36}',
    'AIza[0-9A-Za-z_-]{35}',
    'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    '-----BEGIN[A-Z ]*PRIVATE KEY-----',
    'Bearer\\s+[A-Za-z0-9._-]{20,}',
  ].join('|')
)
