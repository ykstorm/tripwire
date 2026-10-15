import { describe, it, expect } from 'vitest'
import { checkResponse } from '../src'

describe('checkResponse is stateless between calls', () => {
  it('reports the same fabricated stat on every call', () => {
    const text = 'Our company was founded in 1998 and has delivered 50 projects since.'
    const labels = (): string[] => checkResponse(text).violations.filter((v) => v.includes('FABRICATED_STAT'))
    const first = labels()
    expect(first.length).toBeGreaterThan(0)
    expect(labels()).toEqual(first)
    expect(labels()).toEqual(first)
  })
})

describe('checkResponse', () => {
  it('passes clean content', () => {
    const result = checkResponse('Hello, how can I help you today?')
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('catches phone number leak', () => {
    const result = checkResponse('Call us at 9876543210')
    expect(result.passed).toBe(false)
    expect(result.violations.some(v => v.includes('CONTACT_LEAK'))).toBe(true)
  })

  it('catches phone number with prefix', () => {
    const result = checkResponse('call me at: 9988776655')
    expect(result.passed).toBe(false)
  })

  it('handles empty string', () => {
    const result = checkResponse('')
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('passes normal price question without lock trigger', () => {
    const result = checkResponse('What is the price per sqft?')
    expect(result.passed).toBe(true)
  })

  it('passes question without context', () => {
    const result = checkResponse('Tell me about Gala Developers')
    expect(result.passed).toBe(true)
  })

  it('passes normal commission question', () => {
    const result = checkResponse('Do you charge commission?')
    expect(result.passed).toBe(true)
  })
})
describe('card discipline', () => {
  const card = (type: string): string => `<!--CARD:{"type":"${type}","projectId":"p1"}-->`
  const cardViolations = (text: string): string[] =>
    checkResponse(text).violations.filter((v) => v.startsWith('CARD_DISCIPLINE'))

  it.each([
    ['no cards', 'Plain answer.', []],
    ['one project card', `Here it is. ${card('project_card')}`, []],
    ['two project cards', `${card('project_card')} ${card('project_card')}`, []],
    ['a comparison on its own', card('comparison'), []],
    ['two different specialty cards', `${card('cost_breakdown')} ${card('visit_prompt')}`, []],
    [
      'three cards',
      `${card('project_card')} ${card('project_card')} ${card('project_card')}`,
      ['CARD_DISCIPLINE: 3 CARDs exceeds 2-block hard limit'],
    ],
    [
      'a duplicate specialty card',
      `${card('cost_breakdown')} ${card('cost_breakdown')}`,
      ['CARD_DISCIPLINE: duplicate cost_breakdown card (2 found)'],
    ],
    [
      'a comparison next to a project card',
      `${card('comparison')} ${card('project_card')}`,
      ['CARD_DISCIPLINE: comparison must stand alone (no project_card alongside)'],
    ],
    ['an unknown card type', card('teaser'), ['CARD_DISCIPLINE: unknown card type(s) teaser']],
    [
      'every problem at once, in report order',
      `${card('teaser')} ${card('comparison')} ${card('comparison')} ${card('visit_prompt')} ${card('visit_prompt')} ${card('project_card')}`,
      [
        'CARD_DISCIPLINE: 6 CARDs exceeds 2-block hard limit',
        'CARD_DISCIPLINE: duplicate comparison card (2 found)',
        'CARD_DISCIPLINE: duplicate visit_prompt card (2 found)',
        'CARD_DISCIPLINE: comparison must stand alone (no project_card alongside)',
        'CARD_DISCIPLINE: unknown card type(s) teaser',
      ],
    ],
  ])('%s', (_name, text, expected) => {
    expect(cardViolations(text)).toEqual(expected)
  })
})

describe('missing visit call to action', () => {
  const projects = { knownProjectNames: ['Shela Greens'] }
  const visitQuery = { intent: 'visit_query' as const, persona: 'unknown' as const }
  const MISSING = ['MISSING_CTA: project-anchored response without visit CTA']
  const ctaViolations = (text: string, opts: Parameters<typeof checkResponse>[1]): string[] =>
    checkResponse(text, opts).violations.filter((v) => v.startsWith('MISSING_CTA'))

  it.each([
    ['visit_query', 'Can I visit this weekend?'],
    ['comparison_query', 'Which one should I tour first?'],
    ['builder_query', 'Ghar dekhna hai, can we schedule?'],
  ] as const)('flags a %s about a known project when the buyer asks to visit and no CTA is given', (intent, buyerMessage) => {
    const opts = { ...projects, buyerMessage, classified: { intent, persona: 'unknown' as const } }
    expect(ctaViolations('Shela Greens has two towers.', opts)).toEqual(MISSING)
  })

  it('flags an anchor card answer even when the buyer did not ask to visit', () => {
    const text = 'Shela Greens has two towers. <!--CARD:{"type":"project_card","projectId":"p1"}-->'
    expect(ctaViolations(text, { ...projects, classified: visitQuery })).toEqual(MISSING)
  })

  it.each([
    ['a site visit mention', 'Shela Greens has two towers. Want a site visit?'],
    ['an offer to book a visit', 'Shela Greens has two towers. I can book a visit.'],
    ['an offer to schedule a visit', 'Shela Greens has two towers. Shall I schedule a visit?'],
    ['the 30 seconds line', 'Shela Greens has two towers. It takes 30 seconds to set up.'],
    ['a visit_prompt card', 'Shela Greens has two towers. <!--CARD:{"type":"visit_prompt","projectId":"p1"}-->'],
  ])('passes when the answer carries %s', (_name, text) => {
    expect(ctaViolations(text, { ...projects, buyerMessage: 'Can I visit?', classified: visitQuery })).toEqual([])
  })

  it.each([
    ['the intent is not a visit, comparison or builder query', 'Can I visit?', 'project_query', 'Shela Greens has two towers.'],
    ['the buyer did not ask to visit and there is no anchor card', 'How many towers?', 'visit_query', 'Shela Greens has two towers.'],
    ['there is no buyer message and no anchor card', undefined, 'visit_query', 'Shela Greens has two towers.'],
    ['the answer names no known project', 'Can I visit?', 'visit_query', 'Both towers are ready.'],
  ] as const)('passes when %s', (_name, buyerMessage, intent, text) => {
    const opts = { ...projects, buyerMessage, classified: { intent, persona: 'unknown' as const } }
    expect(ctaViolations(text, opts)).toEqual([])
  })

  it('passes with no classification, which defaults to a general query', () => {
    expect(ctaViolations('Shela Greens has two towers.', { ...projects, buyerMessage: 'Can I visit?' })).toEqual([])
  })
})
