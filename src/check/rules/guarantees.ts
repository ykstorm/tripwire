import { GUARANTEE_WORDS, type Rule } from '../shared.js'

const PRICE_GUARANTEE_PATTERN =
  /\b(guarantee|guaranteed|promise|assured?)\b[^.]{0,120}?(price|cost|₹|rs\.?|rupees|lakh|crore|\bL\b|\bCr\b)|\b(price|cost)\b[^.]{0,120}?\bguarantee/i

const SOFT_GUARANTEES = [
  'sure to grow', 'sure to appreciate', 'solid returns',
  'will appreciate', 'guaranteed yield', 'safe bet',
]

export const investmentGuaranteeRule: Rule = (ctx) =>
  GUARANTEE_WORDS.some((w) => ctx.lower.includes(w))
    ? ['INVESTMENT_GUARANTEE: unqualified financial promise in response']
    : []

export const priceGuaranteeRule: Rule = (ctx) =>
  PRICE_GUARANTEE_PATTERN.test(ctx.norm)
    ? ['PRICE_GUARANTEE: model guaranteed a specific price/cost (not authorized)']
    : []

export const personaGuaranteeRule: Rule = (ctx) =>
  ctx.classified.persona === 'investor' && SOFT_GUARANTEES.some((w) => ctx.lower.includes(w))
    ? ['INVESTMENT_GUARANTEE: soft-sell yield language to investor persona']
    : []
