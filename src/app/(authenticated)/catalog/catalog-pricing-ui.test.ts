import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('catalog shows approved average pricing and an auditable source dialog', () => {
  assert.match(source, /Average approved unit price/)
  assert.match(source, /No approved matched history/)
  assert.match(source, /pricingTarget/)
  assert.match(source, /historicalPricing\.sources/)
  assert.match(source, /Historical unit-price calculation/)
})
