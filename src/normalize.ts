// Text normalization applied before every pattern match.
//
// An attacker (or a confused model) can dodge a naive regex by splitting a
// secret with a zero-width space, writing digits in a non-ASCII script, or
// swapping an ASCII hyphen for a look-alike dash. normalize() folds those
// evasions away so the pattern set only has to describe one canonical form:
//
//   1. NFKC - collapses compatibility forms (full-width `９` to `9`, ligatures,
//      etc.) into their canonical ASCII equivalents.
//   2. Strip Unicode format characters (\p{Cf}) - removes zero-width spaces
//      and joiners (U+200B to U+200D, U+2060), the bidi marks and embedding
//      controls (U+200E, U+200F, U+202A to U+202E), the BOM (U+FEFF) and the
//      rest of the category, any of which can be inserted mid-token.
//   3. Map Indic / Arabic decimal digits to ASCII 0-9.
//   4. Fold dash look-alikes (en dash, em dash, minus sign, ...) to '-'.

// The '0' code point of each contiguous 0-9 decimal-digit block we fold.
const DIGIT_BLOCK_BASES = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
]

const DIGIT_RE =
  /[٠-٩۰-۹०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g

function foldDigit(ch: string): string {
  const code = ch.codePointAt(0) as number
  for (const base of DIGIT_BLOCK_BASES) {
    if (code >= base && code <= base + 9) return String(code - base)
  }
  return ch
}

// Dash / hyphen look-alikes folded to ASCII '-'. (NFKC already handles the
// full-width hyphen-minus U+FF0D, but not these.)
const DASH_RE = /[‐‑‒–—―⁃−﹘﹣]/g

/** Invisible format characters. normalize() deletes them, and the streaming
 *  guard leaves them out when it counts the hold-back. */
export const FORMAT_CHARS = /\p{Cf}/gu

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(FORMAT_CHARS, '')
    .replace(DIGIT_RE, foldDigit)
    .replace(DASH_RE, '-')
}
