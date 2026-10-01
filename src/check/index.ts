// checkResponse - post-stream audit for LLM responses. Pure function, no side
// effects: it builds a context once, runs every rule in the table, and returns
// the collected violations. All matching runs on normalized text (see shared.ts)
// so unicode evasions cannot slip a leak past the patterns.

import { buildContext, type CheckOptions, type Rule } from './shared.js'
import { hallucinationRule, missingCtaRule } from './rules/hallucination.js'
import { contactLeakRule, businessLeakRule } from './rules/leaks.js'
import { investmentGuaranteeRule, priceGuaranteeRule, personaGuaranteeRule } from './rules/guarantees.js'
import { outOfAreaRule, projectLimitRule, markdownRule } from './rules/placement.js'
import { languageMismatchRule, nonLatinScriptRule, firstPersonHindiRule } from './rules/language.js'
import { wordCapRule, cardDisciplineRule, softSellRule, ordinalRankingRule } from './rules/format.js'
import { fakeBookingRule, otpFabricationRule, fakeVisitClaimRule, phoneRequestRule } from './rules/booking.js'
import { fabricatedBuilderRule, fabricatedPriceRule, fabricatedStatRule, unverifiedPriceRule } from './rules/fabrication.js'
import { placeholderLeakRule, priceCommitmentRule, commissionRule } from './rules/locks.js'

export type { Intent, Persona, ClassifiedQuery, CheckOptions } from './shared.js'

export interface CheckResult {
  passed: boolean
  violations: string[]
}

/** A response longer than this is rejected rather than scanned. */
export const MAX_CHECK_CHARS = 100_000

/** Thrown when the input exceeds MAX_CHECK_CHARS. */
export class InputTooLargeError extends Error {
  constructor(size: number) {
    super(`INPUT_TOO_LARGE: ${size} chars exceeds ${MAX_CHECK_CHARS}`)
    this.name = 'InputTooLargeError'
  }
}

const RULES: Rule[] = [
  hallucinationRule, missingCtaRule,
  contactLeakRule, businessLeakRule,
  investmentGuaranteeRule, priceGuaranteeRule, personaGuaranteeRule,
  outOfAreaRule, projectLimitRule, markdownRule,
  languageMismatchRule, nonLatinScriptRule, firstPersonHindiRule,
  wordCapRule, cardDisciplineRule, softSellRule, ordinalRankingRule,
  fakeBookingRule, otpFabricationRule, fakeVisitClaimRule, phoneRequestRule,
  fabricatedBuilderRule, fabricatedPriceRule, fabricatedStatRule, unverifiedPriceRule,
  placeholderLeakRule, priceCommitmentRule, commissionRule,
]

export function checkResponse(text: string, opts: CheckOptions = {}): CheckResult {
  if (text.length > MAX_CHECK_CHARS) throw new InputTooLargeError(text.length)
  const ctx = buildContext(text, opts)
  const violations: string[] = []
  for (const rule of RULES) violations.push(...rule(ctx))
  return { passed: violations.length === 0, violations }
}
