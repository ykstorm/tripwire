// Contact leak patterns — exported for real-time onChunk guards.

/**
 * Matches email addresses of the form `@domain.tld`, including hyphenated and
 * multi-label domains (e.g. `@fake-site.com`, `@mail.example.co.uk`).
 */
export const EMAIL_PATTERN = /@[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/

/** Matches 10-digit Indian mobile, +91 prefix, xxx-xxx-xxxx US-style, and email addresses. */
export const CONTACT_LEAK_PATTERN =
  /\d{10}|\+91\s?\d{10}|\d{3}[-\s]\d{3}[-\s]\d{4}|@[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/