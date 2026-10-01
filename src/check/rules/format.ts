import { wordCapFor, type ParsedCard, type Rule } from '../shared.js'

export const wordCapRule: Rule = (ctx) => {
  const wordCount = ctx.prose.split(/\s+/).filter(Boolean).length
  const cap = wordCapFor(ctx.classified.persona)
  return wordCount > cap
    ? [`WORD_CAP: ${wordCount} words exceeds ${cap}-word cap for persona=${ctx.classified.persona}`]
    : []
}

const SPECIALTY_TYPES = ['comparison', 'cost_breakdown', 'visit_prompt', 'builder_trust']
const KNOWN_TYPES = new Set(['project_card', ...SPECIALTY_TYPES])

export const cardDisciplineRule: Rule = (ctx) => {
  const cards: ParsedCard[] = ctx.cards
  if (cards.length === 0) return []
  const out: string[] = []
  if (cards.length > 2) out.push(`CARD_DISCIPLINE: ${cards.length} CARDs exceeds 2-block hard limit`)

  const counts: Record<string, number> = {}
  for (const c of cards) counts[c.type] = (counts[c.type] ?? 0) + 1
  for (const t of SPECIALTY_TYPES) {
    if ((counts[t] ?? 0) > 1) out.push(`CARD_DISCIPLINE: duplicate ${t} card (${counts[t]} found)`)
  }
  if ((counts['comparison'] ?? 0) > 0 && (counts['project_card'] ?? 0) > 0) {
    out.push('CARD_DISCIPLINE: comparison must stand alone (no project_card alongside)')
  }
  for (const t of Object.keys(counts)) {
    if (!KNOWN_TYPES.has(t)) out.push(`CARD_DISCIPLINE: unknown card type(s) ${t}`)
  }
  return out
}

export const softSellRule: Rule = (ctx) =>
  /\b(i recommend|i suggest|you should (?:choose|go for|pick)|best project|top choice|ideal for you)\b/i.test(ctx.norm)
    ? ['SOFT_SELL_PHRASE: recommendation language ("I recommend" / "best project" / "ideal for you")']
    : []

export const ordinalRankingRule: Rule = (ctx) =>
  /\b(1st|2nd|3rd|first choice|second choice|third choice|number one|#1 pick)\b/i.test(ctx.norm)
    ? ['ORDINAL_RANKING: numbered/ordinal ranking language']
    : []
