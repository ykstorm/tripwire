import { INDIC_SCRIPT, hinglishDensity, type Rule } from '../shared.js'

const FIRST_PERSON_HINDI_VERB =
  /\b(samajhta|samajhti|bolta|bolti|kahta|kahti|deta|deti|leta|leti|sochta|sochti|maanta|maanti|chahta|chahti|janta|janti|dekhta|dekhti|sunta|sunti|likhta|likhti|padhta|padhti)\s+hoon\b|\bkarunga\b|\bkarungi\b/i
const FIRST_PERSON_HINDI_PRONOUN = /\b(mujhe|maine)\b/i
const FIRST_PERSON_MAIN_VERB =
  /\bmain\s+(samajhta|samajhti|bolta|bolti|kahta|kahti|deta|deti|leta|leti|sochta|sochti|maanta|maanti|chahta|chahti|janta|janti|dekhta|dekhti|sunta|sunti|likhta|likhti|padhta|padhti|karunga|karungi|hoon|hun)\b/i

export const languageMismatchRule: Rule = (ctx) => {
  if (!ctx.buyerMessage) return []
  const buyerDensity = hinglishDensity(ctx.buyerMessage)
  const responseDensity = hinglishDensity(ctx.norm)
  if (buyerDensity > 0.15 && responseDensity < 0.05) {
    return [
      `LANGUAGE_MISMATCH: buyer wrote Hinglish (density ${(buyerDensity * 100).toFixed(0)}%) ` +
        `but response dropped to English (density ${(responseDensity * 100).toFixed(0)}%)`,
    ]
  }
  if (INDIC_SCRIPT.test(ctx.buyerMessage) && !INDIC_SCRIPT.test(ctx.norm)) {
    return ['LANGUAGE_MISMATCH: buyer wrote in a non-Latin Indic script but response is plain English']
  }
  return []
}

export const nonLatinScriptRule: Rule = (ctx) => {
  const buyerHasNonLatin = !!ctx.buyerMessage && INDIC_SCRIPT.test(ctx.buyerMessage)
  return !buyerHasNonLatin && /[ऀ-ॿ઀-૿]/.test(ctx.norm)
    ? ['NON_LATIN_SCRIPT: response contains Devanagari / Gujarati characters with no buyer cue']
    : []
}

export const firstPersonHindiRule: Rule = (ctx) =>
  FIRST_PERSON_HINDI_VERB.test(ctx.norm) ||
  FIRST_PERSON_HINDI_PRONOUN.test(ctx.norm) ||
  FIRST_PERSON_MAIN_VERB.test(ctx.norm)
    ? ['FIRST_PERSON_HINDI: response uses first-person Hindi pronoun/verb']
    : []
