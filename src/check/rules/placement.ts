import { MARKDOWN_PATTERN } from '../../patterns/index.js'
import { OUT_OF_AREA, type Rule } from '../shared.js'

export const outOfAreaRule: Rule = (ctx) => {
  const mentioned = Array.from(OUT_OF_AREA).filter((a) => ctx.lower.includes(a))
  return mentioned.length > 0 ? [`OUT_OF_AREA: mentioned ${mentioned.join(', ')}`] : []
}

export const projectLimitRule: Rule = (ctx) => {
  const out: string[] = []
  const projectCards = ctx.cards.filter((c) => c.type === 'project_card').length
  const named = ctx.knownProjectNames.filter((p) => p && ctx.lower.includes(p.toLowerCase()))
  if (projectCards > 2) {
    out.push(`PROJECT_LIMIT: ${projectCards} project_card CARDs exceeds 2-project limit`)
  }
  if (named.length > 2) {
    out.push(`PROJECT_LIMIT: ${named.length} distinct project names mentioned (cap 2)`)
  }
  return out
}

export const markdownRule: Rule = (ctx) =>
  MARKDOWN_PATTERN.test(ctx.norm) ? ['NO_MARKDOWN: markdown bullets / bold / headers detected'] : []
