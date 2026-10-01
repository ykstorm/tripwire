// LOCKS-1 patterns - Master Manual §6 Lock #1 (price commit) + Lock #2 (commission).
//
// All three patterns are conservative - false positives would be brand-damaging
// (AI looks like it's enforcing a hidden commission policy when the buyer is
// just chatting). Bidirectional where needed so both Hinglish
// ("3% commission lete hain") and English ("brokerage is 2.5%") fire.
//
// LOCK #1 - specific discount % committed to the buyer.
export const PRICE_DISCOUNT_COMMIT_PATTERN =
  /\b\d{1,2}(?:\.\d{1,2})?\s*(?:%|percent)\s+(?:discount|off|kam|less|cut|reduction)\b/i

// LOCK #1 - specific all-in cost commitment (final/exact/confirmed/locked + price qualifier within 40 chars of ₹).
export const PRICE_FINAL_COMMIT_PATTERN =
  /\b(?:final|exact|confirmed|locked)\s+(?:all.?in|price|cost|rate)[\s\S]{0,40}₹\s*\d/i

// LOCK #2 - numeric commission %, brokerage %, or broker fee % within 30-char proximity.
export const COMMISSION_PATTERN =
  /\b(?:commission|brokerage|broker\s+fee)\b[\s\S]{0,30}\d{1,2}(?:\.\d{1,2})?\s*%|\d{1,2}(?:\.\d{1,2})?\s*%[\s\S]{0,30}\b(?:commission|brokerage|broker\s+fee)\b/i