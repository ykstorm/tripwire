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
const MAX_CARDS = 2

type CardCounts = Record<string, number>

function countCardTypes(cards: ParsedCard[]): CardCounts {
  const counts: CardCounts = {}
  for (const c of cards) counts[c.type] = (counts[c.type] ?? 0) + 1
  return counts
}

function countOf(counts: CardCounts, type: string): number {
  return counts[type] ?? 0
}

function tooManyCards(cards: ParsedCard[]): string[] {
  if (cards.length <= MAX_CARDS) return []
  return [`CARD_DISCIPLINE: ${cards.length} CARDs exceeds ${MAX_CARDS}-block hard limit`]
}

function duplicateSpecialtyCards(counts: CardCounts): string[] {
  return SPECIALTY_TYPES.filter((t) => countOf(counts, t) > 1).map(
    (t) => `CARD_DISCIPLINE: duplicate ${t} card (${counts[t]} found)`
  )
}

function comparisonNotAlone(counts: CardCounts): string[] {
  const together = countOf(counts, 'comparison') > 0 && countOf(counts, 'project_card') > 0
  return together ? ['CARD_DISCIPLINE: comparison must stand alone (no project_card alongside)'] : []
}

function unknownCardTypes(counts: CardCounts): string[] {
  return Object.keys(counts)
    .filter((t) => !KNOWN_TYPES.has(t))
    .map((t) => `CARD_DISCIPLINE: unknown card type(s) ${t}`)
}

export const cardDisciplineRule: Rule = (ctx) => {
  const cards: ParsedCard[] = ctx.cards
  if (cards.length === 0) return []
  const counts = countCardTypes(cards)
  return [
    ...tooManyCards(cards),
    ...duplicateSpecialtyCards(counts),
    ...comparisonNotAlone(counts),
    ...unknownCardTypes(counts),
  ]
}

export const softSellRule: Rule = (ctx) =>
  /\b(i recommend|i suggest|you should (?:choose|go for|pick)|best project|top choice|ideal for you)\b/i.test(ctx.norm)
    ? ['SOFT_SELL_PHRASE: recommendation language ("I recommend" / "best project" / "ideal for you")']
    : []

export const ordinalRankingRule: Rule = (ctx) =>
  /\b(1st|2nd|3rd|first choice|second choice|third choice|number one|#1 pick)\b/i.test(ctx.norm)
    ? ['ORDINAL_RANKING: numbered/ordinal ranking language']
    : []
