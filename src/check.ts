// checkResponse — post-stream audit for LLM responses.
//
// Full audit pass after stream completes. No side effects (no Sentry, no DB).
// All Sentry calls are wrapped in try/catch so this works in any environment.

import {
  BUSINESS_LEAK_PATTERN,
  MARKDOWN_PATTERN,
  PLACEHOLDER_NAME_PATTERN,
  PLACEHOLDER_PRICE_PATTERN,
  PLACEHOLDER_CUID_PATTERN,
  PRICE_DISCOUNT_COMMIT_PATTERN,
  PRICE_FINAL_COMMIT_PATTERN,
  COMMISSION_PATTERN,
} from './patterns/index.js'

export type Intent = 
  | 'general_query'
  | 'project_query'
  | 'comparison_query'
  | 'visit_query'
  | 'builder_query'
  | 'budget_query'
  | 'intent_capture'
  | 'qualification_query'

export type Persona = 'premium' | 'value' | 'investor' | 'unknown'

export interface ClassifiedQuery {
  intent: Intent
  persona: Persona
}

export interface CheckOptions {
  knownProjectNames?: string[]
  knownBuilderNames?: string[]
  unverifiedProjectNames?: string[]
  buyerMessage?: string
  classified?: ClassifiedQuery
}

export interface CheckResult {
  passed: boolean
  violations: string[]
}

const KNOWN_AREAS = new Set([
  'prahlad nagar', 'satellite', 'south bopal', 'shela', 'bopal',
  'vastrapur', 'maninagar', 'gota', 'chandkheda', 'new ranip',
  'ahmedabad', 'gujarat', 'india', 'magicbricks', 'buyerchat'
])

const KNOWN_AMENITIES = new Set([
  'krishna shalby', 'krishna shalby hospital', 'saraswati hospital',
  'tej hospital', 'hcg', 'apollo international', 'cims',
  'dps bopal', 'dps east', 'shanti asiatic', 'shanti asiatic school',
  'mica', 'anant national university', 'nirma university',
  'electrotherm park', 'shaligram oxygen park', 'auda sky city',
  'auda garden', 'bopal lake park',
  'dmart', 'trp mall', 'sobo centre', 'sobo center', 'palladium',
  'club o7', 'gala gymkhana', 'karnavati club', 'rajpath club',
  'bopal brts', 'iskcon cross roads',
  'shri bhidbhanjan hanumanji', 'iskcon temple',
  'hdfc', 'icici', 'sbi', 'axis', 'kotak', 'union bank',
  'yes bank', 'bob', 'bank of baroda',
])

const HINGLISH_MARKERS = new Set([
  'hai', 'kya', 'kar', 'kaise', 'kaha', 'mein', 'ka', 'ki', 'ke',
  'ko', 'se', 'par', 'bhi', 'nahi', 'haan', 'dekh', 'dekho', 'sach',
  'bhai', 'bas', 'sirf', 'matra'
])

const PROPERTY_KEYWORDS = new Set([
  'phase', 'heights', 'park', 'residency', 'greens', 'tower',
  'garden', 'ville', 'enclave', 'plaza', 'square', 'valley',
  'nagar', 'homes', 'estate', 'manor', 'suites', 'lifestyle', 'living'
])

const GUARANTEE_WORDS = [
  'guaranteed', 'will definitely', 'certain to appreciate',
  'assured return', '100% safe', 'no risk', 'cannot lose',
  'promise you', 'guaranteed returns'
]

const OUT_OF_AREA = new Set([
  'satellite', 'prahlad nagar', 'bopal gaon', 'vastrapur',
  'maninagar', 'new ranip', 'chandkheda'
])

const GENERIC_SOLO = new Set(['Group', 'Properties', 'Builders', 'LLP', 'Developers', 'Realty'])

function hinglishDensity(text: string): number {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  const hits = words.filter(w => {
    const stripped = w.replace(/[^a-z]/g, '')
    return HINGLISH_MARKERS.has(stripped)
  }).length
  return hits / words.length
}

function wordCapFor(persona: Persona): number {
  if (persona === 'premium') return 120
  if (persona === 'value') return 80
  return 100
}

interface ParsedCard {
  type: string
  projectId?: string
  projectIdA?: string
  projectIdB?: string
}

function parseCards(text: string): ParsedCard[] {
  const cards: ParsedCard[] = []
  const re = /<!--CARD:(\{[\s\S]*?\})-->/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1]) as ParsedCard
      if (parsed && typeof parsed.type === 'string') cards.push(parsed)
    } catch {
      // ignore malformed
    }
  }
  return cards
}

function checkCardDiscipline(cards: ParsedCard[]): string[] {
  const violations: string[] = []
  if (cards.length === 0) return violations

  if (cards.length > 2) {
    violations.push(`CARD_DISCIPLINE: ${cards.length} CARDs exceeds 2-block hard limit`)
  }

  const counts: Record<string, number> = {}
  for (const c of cards) counts[c.type] = (counts[c.type] ?? 0) + 1

  for (const t of ['comparison', 'cost_breakdown', 'visit_prompt', 'builder_trust']) {
    if ((counts[t] ?? 0) > 1) {
      violations.push(`CARD_DISCIPLINE: duplicate ${t} card (${counts[t]} found)`)
    }
  }

  const _specialtyCount =
    ((counts['comparison'] ?? 0) > 0 ? 1 : 0) +
    ((counts['cost_breakdown'] ?? 0) > 0 ? 1 : 0) +
    ((counts['visit_prompt'] ?? 0) > 0 ? 1 : 0) +
    ((counts['builder_trust'] ?? 0) > 0 ? 1 : 0)
  void _specialtyCount // TODO: wire into card diversity scoring

  if ((counts['comparison'] ?? 0) > 0 && (counts['project_card'] ?? 0) > 0) {
    violations.push('CARD_DISCIPLINE: comparison must stand alone (no project_card alongside)')
  }

  const KNOWN_TYPES = new Set(['project_card', 'comparison', 'cost_breakdown', 'visit_prompt', 'builder_trust'])
  for (const t of Object.keys(counts)) {
    if (!KNOWN_TYPES.has(t)) {
      violations.push(`CARD_DISCIPLINE: unknown card type(s) ${t}`)
    }
  }

  return violations
}

export function checkResponse(text: string, opts: CheckOptions = {}): CheckResult {
  const {
    knownProjectNames = [],
    knownBuilderNames = [],
    unverifiedProjectNames = [],
    buyerMessage,
    classified = { intent: 'general_query', persona: 'unknown' },
  } = opts

  const violations: string[] = []
  const lower = text.toLowerCase()

  // CHECK 1 — Hallucination
  const candidates = text.match(/[A-Z][a-zA-Z]+(\s[A-Z][a-zA-Z]+){1,4}/g) ?? []
  const hallucinated = candidates.filter(name => {
    const l = name.toLowerCase()
    const looksLikeProject = PROPERTY_KEYWORDS.has(l.split(' ').pop() ?? '')
    const isKnown = knownProjectNames.some(p => p.toLowerCase() === l)
    const isKnownArea = KNOWN_AREAS.has(l)
    const isKnownAmenity = KNOWN_AMENITIES.has(l) ||
      Array.from(KNOWN_AMENITIES).some(a => l.includes(a) || a.includes(l))
    return looksLikeProject && !isKnown && !isKnownArea && !isKnownAmenity
  })
  if (hallucinated.length > 0) {
    violations.push(`HALLUCINATION: invented names — ${hallucinated.join(', ')}`)
  }

  // CHECK 2 — MISSING_CTA
  const ctaIntents = new Set<Intent>(['comparison_query', 'visit_query', 'builder_query'])
  const mentionsProject = knownProjectNames.some(p => lower.includes(p.toLowerCase()))
  const projectAnchorCard = /<!--CARD:\{[^}]*"type":"(?:project_card|cost_breakdown|visit_prompt|builder_trust|comparison)"/.test(text)
  const visitSignal = !!buyerMessage && /(visit|schedule|book|tour|see the project|dikha|dekhne|ghar dekhna)/i.test(buyerMessage)
  const intentIsProjectFacing = ctaIntents.has(classified.intent)
  const preconditionsPlausible = intentIsProjectFacing && (visitSignal || projectAnchorCard)
  const hasCTA = lower.includes('site visit') ||
                 lower.includes('book a visit') ||
                 lower.includes('schedule a visit') ||
                 lower.includes('30 seconds') ||
                 /<!--CARD:\{[^}]*"type":"visit_prompt"/.test(text)
  if (preconditionsPlausible && mentionsProject && !hasCTA) {
    violations.push('MISSING_CTA: project-anchored response without visit CTA')
  }

  // CHECK 3 — Contact leak
  if (/\d{10}|\+91\s?\d{10}|\d{3}[-\s]\d{3}[-\s]\d{4}/.test(text)) {
    violations.push('CONTACT_LEAK: phone number pattern detected — CRITICAL')
  }
  if (/@[a-zA-Z0-9]+\.[a-zA-Z]{2,}/.test(text)) {
    violations.push('CONTACT_LEAK: email address pattern detected — CRITICAL')
  }

  // CHECK 3b — Business leak
  if (BUSINESS_LEAK_PATTERN.test(text)) {
    violations.push('BUSINESS_LEAK: commission or partner status mentioned — CRITICAL')
  }

  // CHECK 4 — Investment guarantee
  if (GUARANTEE_WORDS.some(w => lower.includes(w))) {
    violations.push('INVESTMENT_GUARANTEE: unqualified financial promise in response')
  }

  // CHECK 4b — Persona-aware guarantee
  if (classified.persona === 'investor') {
    const softGuarantees = ['sure to grow', 'sure to appreciate', 'solid returns',
      'will appreciate', 'guaranteed yield', 'safe bet']
    if (softGuarantees.some(w => lower.includes(w))) {
      violations.push('INVESTMENT_GUARANTEE: soft-sell yield language to investor persona')
    }
  }

  // CHECK 5 — Out of area
  const mentionedOutOfArea = Array.from(OUT_OF_AREA).filter(a => lower.includes(a))
  if (mentionedOutOfArea.length > 0) {
    violations.push(`OUT_OF_AREA: mentioned ${mentionedOutOfArea.join(', ')}`)
  }

  // CHECK 6 — Project limit
  const allCards = parseCards(text)
  const projectCardCount = allCards.filter(c => c.type === 'project_card').length
  const mentionedProjectNames = knownProjectNames.filter(p => p && lower.includes(p.toLowerCase()))
  if (projectCardCount > 2) {
    violations.push(`PROJECT_LIMIT: ${projectCardCount} project_card CARDs exceeds 2-project limit`)
  }
  if (mentionedProjectNames.length > 2) {
    violations.push(`PROJECT_LIMIT: ${mentionedProjectNames.length} distinct project names mentioned (cap 2)`)
  }

  // CHECK 7 — No markdown
  if (MARKDOWN_PATTERN.test(text)) {
    violations.push('NO_MARKDOWN: markdown bullets / bold / headers detected')
  }

  // CHECK 8 — Language match
  if (buyerMessage) {
    const buyerDensity = hinglishDensity(buyerMessage)
    const responseDensity = hinglishDensity(text)
    if (buyerDensity > 0.15 && responseDensity < 0.05) {
      violations.push(
        `LANGUAGE_MISMATCH: buyer wrote Hinglish (density ${(buyerDensity * 100).toFixed(0)}%) ` +
        `but response dropped to English (density ${(responseDensity * 100).toFixed(0)}%)`
      )
    }
  }
  const buyerHasNonLatin = !!buyerMessage && /[ऀ-ॿ઀-૿]/.test(buyerMessage)
  if (!buyerHasNonLatin && /[ऀ-ॿ઀-૿]/.test(text)) {
    violations.push('NON_LATIN_SCRIPT: response contains Devanagari / Gujarati characters with no buyer cue')
  }

  // CHECK 9 — Word cap
  const prose = text.replace(/<!--CARD:[\s\S]*?-->/g, '').trim()
  const wordCount = prose.split(/\s+/).filter(Boolean).length
  const cap = wordCapFor(classified.persona)
  if (wordCount > cap) {
    violations.push(`WORD_CAP: ${wordCount} words exceeds ${cap}-word cap for persona=${classified.persona}`)
  }

  // CHECK 10 — Card discipline
  violations.push(...checkCardDiscipline(allCards))

  // CHECK 11 — Soft sell
  if (/\b(i recommend|i suggest|you should (?:choose|go for|pick)|best project|top choice|ideal for you)\b/i.test(text)) {
    violations.push('SOFT_SELL_PHRASE: recommendation language ("I recommend" / "best project" / "ideal for you")')
  }

  // CHECK 12 — Ordinal ranking
  if (/\b(1st|2nd|3rd|first choice|second choice|third choice|number one|#1 pick)\b/i.test(text)) {
    violations.push('ORDINAL_RANKING: numbered/ordinal ranking language')
  }

  // CHECK 13 — Fake booking claim
  const FAKE_BOOKING_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /(visit|appointment).{0,40}(scheduled|booked|confirmed|arranged|set up|set\s*up)/i, label: 'visit_claim' },
    { re: /otp.{0,30}(sent|on its way|will be sent|coming|dispatched)/i, label: 'otp_claim' },
    { re: /booking.{0,15}(confirmed|complete|done|successful)/i, label: 'booking_claim' },
    { re: /your (visit|booking|appointment) is (now|all|set|confirmed)/i, label: 'direct_confirm' },
  ]
  const hasVisitPromptCard = allCards.some(c => c.type === 'visit_prompt')
  if (!hasVisitPromptCard) {
    for (const { re, label } of FAKE_BOOKING_PATTERNS) {
      if (re.test(text)) {
        violations.push(`FAKE_BOOKING_CLAIM: ${label} — no visit_prompt CARD in response`)
        break
      }
    }
  }

  // CHECK 14 — Fabricated builder
  if (knownBuilderNames.length > 0) {
    const knownBuilderLower = knownBuilderNames.filter(b => b?.trim()).map(b => b.toLowerCase().trim())
    const knownProjectLower = knownProjectNames.map(p => (p ?? '').toLowerCase().trim())
    const BUILDER_CANDIDATE_RE = /\b([A-Z][a-z]+(?:\s+(?:&\s+)?[A-Z][a-z]+)*)\s+(?:&\s*)?(Group|Properties|Builders|Developers|Constructions|Realty|LLP|Pvt|Estate|Co\.?)\b/g
    const seen = new Set<string>()
    let bm: RegExpExecArray | null
    while ((bm = BUILDER_CANDIDATE_RE.exec(text)) !== null) {
      const fullMatch = bm[0].trim().replace(/\s+/g, ' ')
      const stem = bm[1].trim()
      if (seen.has(fullMatch.toLowerCase())) continue
      seen.add(fullMatch.toLowerCase())
      if (GENERIC_SOLO.has(stem)) continue
      const fullLower = fullMatch.toLowerCase()
      const stemLower = stem.toLowerCase()
      const isKnown = knownBuilderLower.some(k =>
        k === fullLower || k === stemLower || fullLower.includes(k) || k.includes(stemLower)
      )
      if (isKnown) continue
      const isProject = knownProjectLower.some(p =>
        p && (p === fullLower || p === stemLower || fullLower.includes(p) || p.includes(stemLower))
      )
      if (isProject) continue
      violations.push(`FABRICATED_BUILDER: "${fullMatch}" not in known builder allowlist`)
    }
  }

  // CHECK 16 — Fabricated price
  const proseOnly = text.replace(/<!--CARD:[\s\S]*?-->/g, '')
  const FABRICATED_PRICE_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /basic\s+rate\s+(is\s+)?₹\s*[\d,]+(?:\s*\/\s*sqft|\s*\/\s*sq\.?\s*ft\.?)/gi, label: 'per_sqft_rate' },
    { re: /all[\s-]?in\s+(cost|price|total)?\s*(comes\s+to\s+|is\s+|hoga\s+|hogi\s+)?(approximately\s+|~)?₹\s*[\d.]+\s*(L|Cr|lakh|crore)/gi, label: 'all_in_cost' },
    { re: /EMI\s+(would\s+be\s+|is\s+|comes\s+to\s+|hogi\s+|hoga\s+)?(around\s+|approximately\s+)?₹\s*[\d,]+\s*(\/\s*month|per\s+month|pm|monthly)/gi, label: 'emi_amount' },
    { re: /(at\s+|@\s*)[\d.]+\s*%\s*(interest|per\s+annum|p\.?a\.?|annual)/gi, label: 'interest_rate' },
  ]
  for (const { re, label } of FABRICATED_PRICE_PATTERNS) {
    if (re.test(proseOnly)) {
      violations.push(`FABRICATED_PRICE: ${label}`)
    }
  }

  // CHECK 15 — Fabricated stat
  const FABRICATED_STAT_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /(\d{2,4})\s+(projects|units|flats|apartments|homes|towers)\s+(delivered|completed|built|sold)/gi, label: 'delivered_count' },
    { re: /(since|established|founded|from)\s+(in\s+)?(\d{4})/gi, label: 'founding_year' },
    { re: /(\d+)\s+(years?|decades?)\s+(in|of)\s+(business|experience)/gi, label: 'years_in_business' },
  ]
  for (const { re, label } of FABRICATED_STAT_PATTERNS) {
    if (re.test(text)) {
      violations.push(`FABRICATED_STAT: ${label}`)
    }
  }

  // CHECK 17a — OTP fabrication
  const OTP_FABRICATION_PATTERN =
    /\b(otp|code)\s+(bheja|sent|send|share|diya|aaya|on its way|dispatched)\b|\benter\s+(the\s+)?otp\b|\botp\s+(daalein|enter)\b|\bwrong\s+otp\b|\botp\s+(incorrect|galat)\b|\bresend\s+otp\b|\botp\s+resend\b/i
  if (OTP_FABRICATION_PATTERN.test(text)) {
    violations.push('OTP_FABRICATION: model simulated OTP send/verify flow')
  }

  // CHECK 17 — Fake visit claim
  const FAKE_VISIT_CLAIM_PATTERN =
    /(visit|slot)\s+(book(?:ed)?|confirm(?:ed)?|scheduled|locked|done)|visit\s+request\s+note\s+ho\s+gaya|request\s+note\s+ho\s+gaya|preferred\s+slot\s*:/i
  const claimMatch = text.match(FAKE_VISIT_CLAIM_PATTERN)
  if (claimMatch) {
    const visitConfirmationMarker = /<!--CARD:\{[^}]*"type":\s*"visit_confirmation"[^}]*"token":\s*"HST-/i
    if (!visitConfirmationMarker.test(text)) {
      violations.push('FAKE_VISIT_CLAIM: visit-confirmation language without visit_confirmation artifact')
    }
  }

  // CHECK 18 — Phone request in prose (Stage B disabled)
  const PHONE_PROSE_PATTERN =
    /mobile\s+number\s+share|number\s+share\s+kar|phone\s+share|number\s+chahiye|mobile\s+chahiye|calculation\s+unlock|OTP\s+(bheja|enter|verify|aaya)|verify\s+karein|share\s+kar\s+dein/i
  if (PHONE_PROSE_PATTERN.test(text)) {
    violations.push('PHONE_REQUEST_IN_PROSE: AI requesting phone in text while stage B is disabled')
  }

  // CHECK 19 — Price fabrication for unverified projects
  if (unverifiedProjectNames.length > 0) {
    const NUMERIC_PRICE_PATTERN =
      /₹\s*\d[\d,]*\s*(?:\/sqft|\/sq\.?\s*ft|L|Cr|lakh|crore|k\/month|k per month|%)|\d+\.?\d*\s*%/i
    for (const projectName of unverifiedProjectNames) {
      if (!projectName?.trim()) continue
      const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const namePattern = new RegExp(escaped, 'i')
      const nameMatch = text.match(namePattern)
      if (!nameMatch || nameMatch.index === undefined) continue
      const nameIndex = nameMatch.index
      const window200 = text.slice(
        Math.max(0, nameIndex - 100),
        Math.min(text.length, nameIndex + projectName.length + 200)
      )
      if (NUMERIC_PRICE_PATTERN.test(window200)) {
        violations.push(`PRICE_FABRICATION: numeric price near "${projectName}" (unverified project)`)
      }
    }
  }

  // CHECK 20 — First-person Hindi
  const FIRST_PERSON_HINDI_VERB =
    /\b(samajhta|samajhti|bolta|bolti|kahta|kahti|deta|deti|leta|leti|sochta|sochti|maanta|maanti|chahta|chahti|janta|janti|dekhta|dekhti|sunta|sunti|likhta|likhti|padhta|padhti)\s+hoon\b|\bkarunga\b|\bkarungi\b/i
  const FIRST_PERSON_HINDI_PRONOUN = /\b(mujhe|maine)\b/i
  const FIRST_PERSON_MAIN_VERB =
    /\bmain\s+(samajhta|samajhti|bolta|bolti|kahta|kahti|deta|deti|leta|leti|sochta|sochti|maanta|maanti|chahta|chahti|janta|janti|dekhta|dekhti|sunta|sunti|likhta|likhti|padhta|padhti|karunga|karungi|hoon|hun)\b/i
  const fpMatch = FIRST_PERSON_HINDI_VERB.test(text) || FIRST_PERSON_HINDI_PRONOUN.test(text) || FIRST_PERSON_MAIN_VERB.test(text)
  if (fpMatch) {
    violations.push('FIRST_PERSON_HINDI: response uses first-person Hindi pronoun/verb')
  }

  // CHECK 21 — Placeholder leak
  const placeholderLeaks: string[] = []
  if (PLACEHOLDER_NAME_PATTERN.test(text)) placeholderLeaks.push('name')
  if (PLACEHOLDER_PRICE_PATTERN.test(text)) placeholderLeaks.push('price')
  if (PLACEHOLDER_CUID_PATTERN.test(text)) placeholderLeaks.push('cuid')
  if (placeholderLeaks.length > 0) {
    violations.push(`PLACEHOLDER_LEAK: unsubstituted placeholders — ${placeholderLeaks.join(', ')}`)
  }

  // CHECK 22 — Price commitment leak (Lock #1)
  const discountCommit = PRICE_DISCOUNT_COMMIT_PATTERN.test(text)
  const finalCommit = PRICE_FINAL_COMMIT_PATTERN.test(text)
  if (discountCommit || finalCommit) {
    const flagged: string[] = []
    if (discountCommit) flagged.push('discount')
    if (finalCommit) flagged.push('final')
    violations.push(`PRICE_COMMITMENT_LEAK: AI committed to price/discount without admin approval (Lock #1) — ${flagged.join(', ')}`)
  }

  // CHECK 23 — Commission discussion leak (Lock #2)
  if (COMMISSION_PATTERN.test(text)) {
    violations.push('COMMISSION_DISCUSSION_LEAK: AI quoted numeric commission/brokerage % (Lock #2)')
  }

  return { passed: violations.length === 0, violations }
}