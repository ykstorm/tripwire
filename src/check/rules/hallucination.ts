import { KNOWN_AREAS, KNOWN_AMENITIES, PROPERTY_KEYWORDS, type Rule, type RuleContext } from '../shared.js'

const CTA_INTENTS = new Set(['comparison_query', 'visit_query', 'builder_query'])

export const hallucinationRule: Rule = (ctx) => {
  const candidates = ctx.norm.match(/[A-Z][a-zA-Z]+(\s[A-Z][a-zA-Z]+){1,4}/g) ?? []
  const hallucinated = candidates.filter((name) => {
    const l = name.toLowerCase()
    const looksLikeProject = PROPERTY_KEYWORDS.has(l.split(' ').pop() ?? '')
    const isKnown = ctx.knownProjectNames.some((p) => p.toLowerCase() === l)
    const isAmenity =
      KNOWN_AMENITIES.has(l) || Array.from(KNOWN_AMENITIES).some((a) => l.includes(a) || a.includes(l))
    return looksLikeProject && !isKnown && !KNOWN_AREAS.has(l) && !isAmenity
  })
  return hallucinated.length > 0 ? [`HALLUCINATION: invented names - ${hallucinated.join(', ')}`] : []
}

const ANCHOR_CARD = /<!--CARD:\{[^}]*"type":"(?:project_card|cost_breakdown|visit_prompt|builder_trust|comparison)"/
const VISIT_PROMPT_CARD = /<!--CARD:\{[^}]*"type":"visit_prompt"/
const VISIT_WORDS = /(visit|schedule|book|tour|see the project|dikha|dekhne|ghar dekhna)/i
const CTA_PHRASES = ['site visit', 'book a visit', 'schedule a visit', '30 seconds']

function mentionsKnownProject(ctx: RuleContext): boolean {
  return ctx.knownProjectNames.some((p) => ctx.lower.includes(p.toLowerCase()))
}

function buyerAskedToVisit(ctx: RuleContext): boolean {
  return !!ctx.buyerMessage && VISIT_WORDS.test(ctx.buyerMessage)
}

/** A visit, comparison or builder query where the buyer asked to visit or the answer is anchored on a card. */
function visitCtaExpected(ctx: RuleContext): boolean {
  return CTA_INTENTS.has(ctx.classified.intent) && (buyerAskedToVisit(ctx) || ANCHOR_CARD.test(ctx.text))
}

function hasVisitCta(ctx: RuleContext): boolean {
  return CTA_PHRASES.some((phrase) => ctx.lower.includes(phrase)) || VISIT_PROMPT_CARD.test(ctx.text)
}

export const missingCtaRule: Rule = (ctx) => {
  const missing = visitCtaExpected(ctx) && mentionsKnownProject(ctx) && !hasVisitCta(ctx)
  return missing ? ['MISSING_CTA: project-anchored response without visit CTA'] : []
}
