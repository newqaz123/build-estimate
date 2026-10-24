import assert from 'node:assert/strict'
import test from 'node:test'

import { parseEstimateStatus, prepareEstimateItems } from './estimate-save'

function line(overrides: Record<string, unknown> = {}) {
  return {
    code: '',
    desc: 'Rebar SD40 16mm',
    unit: 'ton',
    qty: 10,
    rate: 100,
    total: 1,
    source: 'manual',
    ...overrides,
  }
}

test('line totals are priced from quantity × unit price, never from the total the browser sends', () => {
  const result = prepareEstimateItems([
    line(),
    line({ desc: 'Ready-mix concrete', unit: 'm³', qty: 2.5, rate: 2400, total: 999999 }),
  ])

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.items.map((item) => item.total), [1000, 6000])
  assert.equal(result.totalAmount, 7000)
})

test('an empty estimate is allowed and totals zero', () => {
  assert.deepEqual(prepareEstimateItems([]), { ok: true, items: [], totalAmount: 0 })
})

test('lines with a negative, missing, or non-numeric quantity or unit price are refused by line number', () => {
  const badQty = 'quantity must be a number of zero or more.'
  const badRate = 'unit price must be a number of zero or more.'
  assert.deepEqual(prepareEstimateItems([line(), line({ qty: -1 })]), { ok: false, error: `Line 2: ${badQty}` })
  assert.deepEqual(prepareEstimateItems([line({ qty: undefined })]), { ok: false, error: `Line 1: ${badQty}` })
  assert.deepEqual(prepareEstimateItems([line({ rate: '100' })]), { ok: false, error: `Line 1: ${badRate}` })
  assert.deepEqual(prepareEstimateItems([line({ rate: Number.POSITIVE_INFINITY })]), { ok: false, error: `Line 1: ${badRate}` })
})

test('totals too large to store are refused instead of being saved as empty', () => {
  assert.deepEqual(
    prepareEstimateItems([line({ qty: 1e308, rate: 2 })]),
    { ok: false, error: 'Line 1: total is too large.' },
  )
  assert.deepEqual(
    prepareEstimateItems([line({ qty: 1e308, rate: 1 }), line({ qty: 1e308, rate: 1 })]),
    { ok: false, error: 'Estimate total is too large.' },
  )
})

test('malformed lines and lists are refused', () => {
  assert.deepEqual(prepareEstimateItems('nope'), { ok: false, error: 'Items must be a list.' })
  assert.deepEqual(prepareEstimateItems([null]), { ok: false, error: 'Line 1 is not a valid estimate line.' })
  assert.deepEqual(prepareEstimateItems([line({ desc: 42 })]), { ok: false, error: 'Line 1: description must be text.' })
  assert.deepEqual(prepareEstimateItems([line({ unit: null })]), { ok: false, error: 'Line 1: unit must be text.' })
})

test('only known fields are stored, unknown sources become manual, and catalog snapshots are kept', () => {
  const result = prepareEstimateItems([
    line({
      source: 'hacked',
      priceOverride: 1,
      stdId: 'std-1',
      stdSnapshot: { description: 'Rebar SD40 16mm', unit: 'ton' },
    }),
  ])

  assert.deepEqual(result, {
    ok: true,
    totalAmount: 1000,
    items: [{
      code: '',
      desc: 'Rebar SD40 16mm',
      unit: 'ton',
      qty: 10,
      rate: 100,
      total: 1000,
      source: 'manual',
      stdId: 'std-1',
      stdSnapshot: { description: 'Rebar SD40 16mm', unit: 'ton' },
    }],
  })
})

test('estimate status accepts only draft or final', () => {
  assert.equal(parseEstimateStatus('draft'), 'draft')
  assert.equal(parseEstimateStatus('final'), 'final')
  assert.equal(parseEstimateStatus('approved'), null)
  assert.equal(parseEstimateStatus(1), null)
})
