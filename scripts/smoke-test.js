#!/usr/bin/env node
/**
 * smoke-test.js — End-to-end smoke test for guardrail-proxy
 * Run: node scripts/smoke-test.js
 *
 * Tests the guard against real problematic patterns.
 * No network required — pure function tests using StreamingGuard.
 */

const { checkResponse, StreamingGuard } = require('../dist/index.js')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`)
    failed++
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`)
}

console.log('\n=== guardrail-proxy smoke tests ===\n')

// --- checkResponse tests ---

console.log('[checkResponse]')
test('clean content passes', () => {
  const result = checkResponse('The 2BHK apartment costs ₹45 lakhs.')
  assertEqual(result.passed, true, 'clean content should pass')
})

test('phone number is blocked', () => {
  const result = checkResponse('Call us at 9988776655 for booking.')
  assertEqual(result.passed, false, 'phone number should be blocked')
  if (!result.violations.some(v => v.includes('CONTACT_LEAK'))) throw new Error('expected CONTACT_LEAK violation')
})

test('email (with hyphenated domain) is blocked', () => {
  const result = checkResponse('Email: scammer@fake-site.com to book.')
  assertEqual(result.passed, false, 'email should be blocked')
  if (!result.violations.some(v => v.includes('CONTACT_LEAK'))) throw new Error('expected CONTACT_LEAK violation')
})

test('price guarantee is blocked', () => {
  const result = checkResponse('We guarantee this property will cost exactly ₹50 lakhs.')
  assertEqual(result.passed, false, 'price guarantee should be blocked')
  if (!result.violations.some(v => v.includes('PRICE_GUARANTEE'))) throw new Error('expected PRICE_GUARANTEE violation')
})

test('investment guarantee is blocked', () => {
  const result = checkResponse('Invest in this property and get 30% returns guaranteed.')
  assertEqual(result.passed, false, 'investment guarantee should be blocked')
  if (!result.violations.some(v => v.includes('INVESTMENT_GUARANTEE'))) throw new Error('expected INVESTMENT_GUARANTEE violation')
})

test('buyer message language mismatch is detected', () => {
  // Buyer wrote in Hindi, LLM responded in English
  const result = checkResponse('The property is available in Bangalore.', {
    buyerMessage: 'ನಾನು ಬೆಂಗಳೂರಿನಲ್ಲಿ ಮನೆ ಬಯಸುತ್ತೇನೆ',
  })
  assertEqual(result.passed, false, 'language mismatch should be blocked')
  if (!result.violations.some(v => v.includes('LANGUAGE_MISMATCH'))) throw new Error('expected LANGUAGE_MISMATCH violation')
})

// --- StreamingGuard tests ---

console.log('\n[StreamingGuard]')
test('clean chunk stream passes', () => {
  const violations = []
  const guard = new StreamingGuard({
    onViolate: (v) => violations.push(v),
  })
  guard.onChunk('The ')
  guard.onChunk('property ')
  guard.onChunk('costs ')
  guard.onChunk('₹45 ')
  guard.onChunk('lakhs.')
  assertEqual(violations.length, 0, 'no violations expected')
})

test('phone number in chunk triggers abort', () => {
  let abortViolations = []
  const guard = new StreamingGuard({
    onAbort: (v) => abortViolations.push(v),
    onViolate: (v) => {},
  })
  guard.onChunk('Call ')
  guard.onChunk('us ')
  guard.onChunk('at ')
  try {
    guard.onChunk('9988776655')
  } catch (e) {
    // expected
  }
  if (abortViolations.length === 0) throw new Error('expected phone abort violation')
})

test('.reset() clears violations', () => {
  const violations = []
  const guard = new StreamingGuard({
    onViolate: (v) => violations.push(v),
  })
  guard.onChunk('The final price is ₹45,000')
  guard.reset()
  assertEqual(guard.violations.length, 0, 'violations should be empty after reset')
})

test('hard abort delivers partial content before the banned token', () => {
  // The consumer accumulates delivered text and stops on abort (the documented
  // streaming pattern). The banned token must NOT be in the delivered output.
  let delivered = ''
  const guard = new StreamingGuard({
    onAbort: () => { throw new Error('ABORT') },
  })
  for (const chunk of ['The property ', 'call 9988776655 now']) {
    try {
      guard.onChunk(chunk)
      delivered += chunk
    } catch (e) {
      break
    }
  }
  if (!delivered.includes('The property')) throw new Error('delivered should include partial text')
  if (delivered.includes('9988776655')) throw new Error('banned phone token must not be delivered')
})

test('custom pattern merges with built-ins and fires', () => {
  const observed = []
  const guard = new StreamingGuard({
    patterns: [{ pattern: /\bsecret-project-x\b/i, label: 'CUSTOM_CODENAME', mode: 'observe' }],
    onViolate: (v) => observed.push(v),
  })
  guard.onChunk('We are launching secret-project-x next month')
  if (!observed.some(v => v.includes('CUSTOM_CODENAME'))) throw new Error('expected custom pattern to fire')
})

// --- Summary ---

console.log('\n=== Results ===')
console.log(`  Passed: ${passed}`)
console.log(`  Failed: ${failed}`)
if (failed > 0) {
  console.log('\nSMOKE TEST FAILED')
  process.exit(1)
} else {
  console.log('\nAll smoke tests passed ✓')
  process.exit(0)
}