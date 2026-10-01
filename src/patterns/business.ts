// Business-sensitive leak patterns - "commission rate", "partner status", "commission %".

/** Detects business-leak keywords that should not appear in buyer-facing AI output. */
export const BUSINESS_LEAK_PATTERN = /commission rate|partner status|commission %/i