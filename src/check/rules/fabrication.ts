import { GENERIC_SOLO, type Rule } from '../shared.js'

const BUILDER_CANDIDATE_RE =
  /\b((?:[A-Z][a-z]+\s+){0,4}[A-Z][a-z]+)\s+(?:&\s*)?(Group|Properties|Builders|Developers|Constructions|Realty|LLP|Pvt|Estate|Co\.?)\b/g

const FABRICATED_PRICE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /basic\s+rate\s+(is\s+)?₹\s*[\d,]+(?:\s*\/\s*sqft|\s*\/\s*sq\.?\s*ft\.?)/gi, label: 'per_sqft_rate' },
  { re: /all[\s-]?in\s+(cost|price|total)?\s*(comes\s+to\s+|is\s+|hoga\s+|hogi\s+)?(approximately\s+|~)?₹\s*[\d.]+\s*(L|Cr|lakh|crore)/gi, label: 'all_in_cost' },
  { re: /EMI\s+(would\s+be\s+|is\s+|comes\s+to\s+|hogi\s+|hoga\s+)?(around\s+|approximately\s+)?₹\s*[\d,]+\s*(\/\s*month|per\s+month|pm|monthly)/gi, label: 'emi_amount' },
  { re: /(at\s+|@\s*)[\d.]+\s*%\s*(interest|per\s+annum|p\.?a\.?|annual)/gi, label: 'interest_rate' },
]

const FABRICATED_STAT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(\d{2,4})\s+(projects|units|flats|apartments|homes|towers)\s+(delivered|completed|built|sold)/gi, label: 'delivered_count' },
  { re: /(since|established|founded|from)\s+(in\s+)?(\d{4})/gi, label: 'founding_year' },
  { re: /(\d+)\s+(years?|decades?)\s+(in|of)\s+(business|experience)/gi, label: 'years_in_business' },
]

const NUMERIC_PRICE_PATTERN =
  /₹\s*\d[\d,]*\s*(?:\/sqft|\/sq\.?\s*ft|L|Cr|lakh|crore|k\/month|k per month|%)|\d+\.?\d*\s*%/i

export const fabricatedBuilderRule: Rule = (ctx) => {
  if (ctx.knownBuilderNames.length === 0) return []
  const builders = ctx.knownBuilderNames.filter((b) => b?.trim()).map((b) => b.toLowerCase().trim())
  const projects = ctx.knownProjectNames.map((p) => (p ?? '').toLowerCase().trim())
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = BUILDER_CANDIDATE_RE.exec(ctx.norm)) !== null) {
    const full = m[0].trim().replace(/\s+/g, ' ')
    const stem = m[1].trim()
    const fullLower = full.toLowerCase()
    if (seen.has(fullLower)) continue
    seen.add(fullLower)
    if (GENERIC_SOLO.has(stem)) continue
    const stemLower = stem.toLowerCase()
    const known = builders.some((k) => k === fullLower || k === stemLower || fullLower.includes(k) || k.includes(stemLower))
    const isProject = projects.some((p) => p && (p === fullLower || p === stemLower || fullLower.includes(p) || p.includes(stemLower)))
    if (!known && !isProject) out.push(`FABRICATED_BUILDER: "${full}" not in known builder allowlist`)
  }
  return out
}

export const fabricatedPriceRule: Rule = (ctx) =>
  FABRICATED_PRICE_PATTERNS.filter(({ re }) => re.test(ctx.prose)).map(({ label }) => `FABRICATED_PRICE: ${label}`)

export const fabricatedStatRule: Rule = (ctx) =>
  FABRICATED_STAT_PATTERNS.filter(({ re }) => re.test(ctx.norm)).map(({ label }) => `FABRICATED_STAT: ${label}`)

export const unverifiedPriceRule: Rule = (ctx) => {
  if (ctx.unverifiedProjectNames.length === 0) return []
  const out: string[] = []
  for (const name of ctx.unverifiedProjectNames) {
    if (!name?.trim()) continue
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hit = ctx.norm.match(new RegExp(escaped, 'i'))
    if (!hit || hit.index === undefined) continue
    const window = ctx.norm.slice(Math.max(0, hit.index - 100), Math.min(ctx.norm.length, hit.index + name.length + 200))
    if (NUMERIC_PRICE_PATTERN.test(window)) {
      out.push(`PRICE_FABRICATION: numeric price near "${name}" (unverified project)`)
    }
  }
  return out
}
