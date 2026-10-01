import { KNOWN_AREAS, KNOWN_AMENITIES, PROPERTY_KEYWORDS, type Rule } from '../shared.js'

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

export const missingCtaRule: Rule = (ctx) => {
  const mentionsProject = ctx.knownProjectNames.some((p) => ctx.lower.includes(p.toLowerCase()))
  const anchorCard = /<!--CARD:\{[^}]*"type":"(?:project_card|cost_breakdown|visit_prompt|builder_trust|comparison)"/.test(ctx.text)
  const visitSignal = !!ctx.buyerMessage && /(visit|schedule|book|tour|see the project|dikha|dekhne|ghar dekhna)/i.test(ctx.buyerMessage)
  const plausible = CTA_INTENTS.has(ctx.classified.intent) && (visitSignal || anchorCard)
  const hasCTA =
    ctx.lower.includes('site visit') ||
    ctx.lower.includes('book a visit') ||
    ctx.lower.includes('schedule a visit') ||
    ctx.lower.includes('30 seconds') ||
    /<!--CARD:\{[^}]*"type":"visit_prompt"/.test(ctx.text)
  return plausible && mentionsProject && !hasCTA
    ? ['MISSING_CTA: project-anchored response without visit CTA']
    : []
}
