// Contact-leak patterns - exported for real-time onChunk guards.
//
// All matching happens on normalized text (see src/normalize.ts), so these only
// have to describe the canonical ASCII form.

/**
 * Matches email addresses of the form `@domain.tld`, including hyphenated and
 * multi-label domains (e.g. `@fake-site.com`, `@mail.example.co.uk`).
 */
export const EMAIL_PATTERN =
  /@[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/

/**
 * Matches phone numbers, bounded by `(?<!\d)…(?!\d)` so a longer run of digits
 * (a unix timestamp, a RERA registration id) does not trip it.
 *
 * - Indian mobile: optional `+91`, a leading 6-9, then 9 more digits, with an
 *   optional separator at the 5-digit split (`98765 43210`, `98765-43210`).
 * - US: `xxx-xxx-xxxx` with space or dash separators.
 */
export const PHONE_PATTERN =
  /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)|(?<!\d)\d{3}[-\s]\d{3}[-\s]\d{4}(?!\d)/

/** Phone numbers or email addresses in buyer-facing output. */
export const CONTACT_LEAK_PATTERN = new RegExp(
  `${PHONE_PATTERN.source}|${EMAIL_PATTERN.source}`
)
