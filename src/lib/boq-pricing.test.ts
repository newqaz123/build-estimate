import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateBoqTotals,
  contributesToBoqTotal,
  isPricedBoqItem,
} from './boq-pricing'
import type {
  BoqInformationalItem,
  BoqPricedItem,
  BoqSection,
} from './boq-schema'

function pricedItem(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return {
    id: 'priced-item',
    desc: 'Priced work',
    unit: 'item',
    qty: 1,
    rate: 100,
    total: 100,
    type: 'unit',
    stdStatus: 'unmatched',
    ...overrides,
  }
}

function informationalItem(
  overrides: Partial<BoqInformationalItem> = {},
): BoqInformationalItem {
  return {
    id: 'bundle-child',
    desc: 'Included component',
    pricingRole: 'bundle_child',
    parentBundleId: 'bundle',
    stdStatus: 'unmatched',
    ...overrides,
  }
}

test('counts priced bundle parents and excluded options but totals only contributing items', () => {
  const sections: BoqSection[] = [{
    header: 'Pump',
    items: [
      pricedItem({ id: 'bundle', pricingRole: 'bundle_parent', total: 95_200 }),
      informationalItem({ id: 'pump-body', parentBundleId: 'bundle' }),
      pricedItem({
        id: 'option',
        total: 10_000,
        excludedFromTotal: true,
        optional: true,
        exclusionReason: 'Client option',
      }),
    ],
  }]

  assert.deepEqual(calculateBoqTotals(sections), { totalItems: 2, grandTotal: 95_200 })
  assert.equal(isPricedBoqItem(sections[0].items[0]), true)
  assert.equal(isPricedBoqItem(sections[0].items[1]), false)
  assert.equal(contributesToBoqTotal(sections[0].items[2]), false)
})

test('treats legacy items without pricingRole as contributing priced items', () => {
  const legacy = pricedItem({ pricingRole: undefined, total: 250 })

  assert.equal(isPricedBoqItem(legacy), true)
  assert.equal(contributesToBoqTotal(legacy), true)
  assert.deepEqual(calculateBoqTotals([{ header: 'Legacy', items: [legacy] }]), {
    totalItems: 1,
    grandTotal: 250,
  })
})

test('informational bundle children never contribute to item counts or totals', () => {
  const child = informationalItem({
    sourceRowId: 'row-2',
    sourceRowIds: ['row-2', 'row-3'],
    entryOrigin: 'docling',
  })

  assert.equal(isPricedBoqItem(child), false)
  assert.equal(contributesToBoqTotal(child), false)
  assert.deepEqual(calculateBoqTotals([{ header: 'Bundle', items: [child] }]), {
    totalItems: 0,
    grandTotal: 0,
  })
})

test('rejects non-finite contributing totals instead of producing NaN', () => {
  for (const total of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => calculateBoqTotals([{ header: 'Invalid', items: [pricedItem({ total })] }]),
      /finite/i,
    )
  }
})

test('rejects negative contributing totals', () => {
  assert.throws(
    () => calculateBoqTotals([{ header: 'Invalid', items: [pricedItem({ total: -1 })] }]),
    /non-negative/i,
  )
})

test('does not validate the total of an explicitly excluded priced option', () => {
  const excluded = pricedItem({
    total: Number.NaN,
    optional: true,
    excludedFromTotal: true,
  })

  assert.deepEqual(calculateBoqTotals([{ header: 'Options', items: [excluded] }]), {
    totalItems: 1,
    grandTotal: 0,
  })
})
