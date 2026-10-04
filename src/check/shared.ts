// Shared context, constants, and helpers for the checkResponse rule table.

import { normalize } from '../normalize.js'

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

export interface ParsedCard {
  type: string
  projectId?: string
  projectIdA?: string
  projectIdB?: string
}

/** Everything a rule needs, computed once per checkResponse call. */
export interface RuleContext {
  text: string
  norm: string
  lower: string
  prose: string
  cards: ParsedCard[]
  knownProjectNames: string[]
  knownBuilderNames: string[]
  unverifiedProjectNames: string[]
  buyerMessage?: string
  classified: ClassifiedQuery
}

/** A rule inspects the context and returns zero or more violation strings. */
export type Rule = (ctx: RuleContext) => string[]

export const KNOWN_AREAS = new Set([
  'prahlad nagar', 'satellite', 'south bopal', 'shela', 'bopal',
  'vastrapur', 'maninagar', 'gota', 'chandkheda', 'new ranip',
  'ahmedabad', 'gujarat', 'india', 'magicbricks', 'buyerchat',
])

export const KNOWN_AMENITIES = new Set([
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
  'bhai', 'bas', 'sirf', 'matra',
])

export const PROPERTY_KEYWORDS = new Set([
  'phase', 'heights', 'park', 'residency', 'greens', 'tower',
  'garden', 'ville', 'enclave', 'plaza', 'square', 'valley',
  'nagar', 'homes', 'estate', 'manor', 'suites', 'lifestyle', 'living',
])

export const GUARANTEE_WORDS = [
  'guaranteed', 'will definitely', 'certain to appreciate',
  'assured return', '100% safe', 'no risk', 'cannot lose',
  'promise you', 'guaranteed returns',
]

export const OUT_OF_AREA = new Set([
  'satellite', 'prahlad nagar', 'bopal gaon', 'vastrapur',
  'maninagar', 'new ranip', 'chandkheda',
])

export const GENERIC_SOLO = new Set(['Group', 'Properties', 'Builders', 'LLP', 'Developers', 'Realty'])

export const INDIC_SCRIPT = /[ऀ-෿]/

export function hinglishDensity(text: string): number {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  const hits = words.filter((w) => HINGLISH_MARKERS.has(w.replace(/[^a-z]/g, ''))).length
  return hits / words.length
}

export function wordCapFor(persona: Persona): number {
  if (persona === 'premium') return 120
  if (persona === 'value') return 80
  return 100
}

function parseCards(text: string): ParsedCard[] {
  const cards: ParsedCard[] = []
  const re = /<!--CARD:(\{[\s\S]*?\})-->/g
  let cardMatch: RegExpExecArray | null
  while ((cardMatch = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(cardMatch[1]) as ParsedCard
      if (parsed && typeof parsed.type === 'string') cards.push(parsed)
    } catch {
      // ignore malformed
    }
  }
  return cards
}

export function buildContext(text: string, opts: CheckOptions): RuleContext {
  const norm = normalize(text)
  return {
    text,
    norm,
    lower: norm.toLowerCase(),
    prose: norm.replace(/<!--CARD:[\s\S]*?-->/g, '').trim(),
    cards: parseCards(text),
    knownProjectNames: opts.knownProjectNames ?? [],
    knownBuilderNames: opts.knownBuilderNames ?? [],
    unverifiedProjectNames: opts.unverifiedProjectNames ?? [],
    buyerMessage: opts.buyerMessage,
    classified: opts.classified ?? { intent: 'general_query', persona: 'unknown' },
  }
}
