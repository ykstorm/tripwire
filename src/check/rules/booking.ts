import type { Rule } from '../shared.js'

const FAKE_BOOKING_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(visit|appointment).{0,40}(scheduled|booked|confirmed|arranged|set up|set\s*up)/i, label: 'visit_claim' },
  { re: /otp.{0,30}(sent|on its way|will be sent|coming|dispatched)/i, label: 'otp_claim' },
  { re: /booking.{0,15}(confirmed|complete|done|successful)/i, label: 'booking_claim' },
  { re: /your (visit|booking|appointment) is (now|all|set|confirmed)/i, label: 'direct_confirm' },
]

const OTP_FABRICATION_PATTERN =
  /\b(otp|code)\s+(bheja|sent|send|share|diya|aaya|on its way|dispatched)\b|\benter\s+(the\s+)?otp\b|\botp\s+(daalein|enter)\b|\bwrong\s+otp\b|\botp\s+(incorrect|galat)\b|\bresend\s+otp\b|\botp\s+resend\b/i

const FAKE_VISIT_CLAIM_PATTERN =
  /(visit|slot)\s+(book(?:ed)?|confirm(?:ed)?|scheduled|locked|done)|visit\s+request\s+note\s+ho\s+gaya|request\s+note\s+ho\s+gaya|preferred\s+slot\s*:/i

const PHONE_PROSE_PATTERN =
  /mobile\s+number\s+share|number\s+share\s+kar|phone\s+share|number\s+chahiye|mobile\s+chahiye|calculation\s+unlock|OTP\s+(bheja|enter|verify|aaya)|verify\s+karein|share\s+kar\s+dein/i

export const fakeBookingRule: Rule = (ctx) => {
  if (ctx.cards.some((c) => c.type === 'visit_prompt')) return []
  for (const { re, label } of FAKE_BOOKING_PATTERNS) {
    if (re.test(ctx.norm)) return [`FAKE_BOOKING_CLAIM: ${label} - no visit_prompt CARD in response`]
  }
  return []
}

export const otpFabricationRule: Rule = (ctx) =>
  OTP_FABRICATION_PATTERN.test(ctx.norm) ? ['OTP_FABRICATION: model simulated OTP send/verify flow'] : []

export const fakeVisitClaimRule: Rule = (ctx) => {
  if (!FAKE_VISIT_CLAIM_PATTERN.test(ctx.norm)) return []
  const marker = /<!--CARD:\{[^}]*"type":\s*"visit_confirmation"[^}]*"token":\s*"HST-/i
  return marker.test(ctx.text)
    ? []
    : ['FAKE_VISIT_CLAIM: visit-confirmation language without visit_confirmation artifact']
}

export const phoneRequestRule: Rule = (ctx) =>
  PHONE_PROSE_PATTERN.test(ctx.norm)
    ? ['PHONE_REQUEST_IN_PROSE: AI requesting phone in text while stage B is disabled']
    : []
