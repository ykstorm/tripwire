// Secret / credential leak pattern — a hard-abort guard. An LLM that echoes an
// API key, access token, or private key into its response has leaked a
// credential the moment those tokens reach the user, so this aborts the stream
// on the first match (same treatment as CONTACT_LEAK).
//
// Each alternative is anchored to a provider-specific prefix + a minimum length
// so ordinary prose ("the API key is in the vault", "bearer of bad news") does
// not trip it — a match requires a real high-entropy token shape. All quantifiers
// are simple and bounded (no nested repetition) to avoid catastrophic backtracking.

/**
 * Matches common leaked credentials in a token stream:
 * - Anthropic keys      `sk-ant-…`
 * - OpenAI keys         `sk-…` / `sk-proj-…`
 * - AWS access key ids  `AKIA…`
 * - GitHub tokens       `ghp_/gho_/ghs_/ghr_/ghu_…`
 * - Google API keys     `AIza…`
 * - Slack tokens        `xoxb-/xoxp-/xoxa-/xoxr-/xoxs-…`
 * - PEM private keys     `-----BEGIN … PRIVATE KEY-----`
 * - Long Bearer tokens   `Bearer <20+ token chars>`
 */
export const SECRET_LEAK_PATTERN =
  /sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[opsur]_[A-Za-z0-9]{36}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN[A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{20,}/
