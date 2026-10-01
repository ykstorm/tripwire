import { BUSINESS_LEAK_PATTERN, PHONE_PATTERN, EMAIL_PATTERN } from '../../patterns/index.js'
import type { Rule } from '../shared.js'

export const contactLeakRule: Rule = (ctx) => {
  const out: string[] = []
  if (PHONE_PATTERN.test(ctx.norm)) out.push('CONTACT_LEAK: phone number pattern detected')
  if (EMAIL_PATTERN.test(ctx.norm)) out.push('CONTACT_LEAK: email address pattern detected')
  return out
}

export const businessLeakRule: Rule = (ctx) =>
  BUSINESS_LEAK_PATTERN.test(ctx.norm) ? ['BUSINESS_LEAK: commission or partner-status language'] : []
