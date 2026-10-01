import {
  PLACEHOLDER_NAME_PATTERN,
  PLACEHOLDER_PRICE_PATTERN,
  PLACEHOLDER_CUID_PATTERN,
  PRICE_DISCOUNT_COMMIT_PATTERN,
  PRICE_FINAL_COMMIT_PATTERN,
  COMMISSION_PATTERN,
} from '../../patterns/index.js'
import type { Rule } from '../shared.js'

export const placeholderLeakRule: Rule = (ctx) => {
  const leaks: string[] = []
  if (PLACEHOLDER_NAME_PATTERN.test(ctx.norm)) leaks.push('name')
  if (PLACEHOLDER_PRICE_PATTERN.test(ctx.norm)) leaks.push('price')
  if (PLACEHOLDER_CUID_PATTERN.test(ctx.norm)) leaks.push('cuid')
  return leaks.length > 0 ? [`PLACEHOLDER_LEAK: unsubstituted placeholders - ${leaks.join(', ')}`] : []
}

export const priceCommitmentRule: Rule = (ctx) => {
  const flagged: string[] = []
  if (PRICE_DISCOUNT_COMMIT_PATTERN.test(ctx.norm)) flagged.push('discount')
  if (PRICE_FINAL_COMMIT_PATTERN.test(ctx.norm)) flagged.push('final')
  return flagged.length > 0
    ? [`PRICE_COMMITMENT_LEAK: AI committed to price/discount without admin approval (Lock #1) - ${flagged.join(', ')}`]
    : []
}

export const commissionRule: Rule = (ctx) =>
  COMMISSION_PATTERN.test(ctx.norm)
    ? ['COMMISSION_DISCUSSION_LEAK: AI quoted numeric commission/brokerage % (Lock #2)']
    : []
