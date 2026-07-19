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
      () => calculateBoqTotals([{
        header: 'SENTINEL-SOURCE-HEADER',
        items: [pricedItem({
          id: 'bad-total',
          code: 'SENTINEL-SOURCE-CODE',
          desc: 'SENTINEL-SOURCE-DESCRIPTION',
          total,
        })],
      }]),
      (error: unknown) => {
        assert.ok(error instanceof RangeError)
        assert.match(error.message, /finite/i)
        assert.match(error.message, /section index 1/)
        assert.match(error.message, /item id "bad-total"/)
        assert.doesNotMatch(error.message, /SENTINEL-SOURCE-(?:HEADER|CODE|DESCRIPTION)/)
        return true
      },
    )
  }
})

test('rejects negative contributing totals', () => {
  assert.throws(
    () => calculateBoqTotals([{
      header: 'SENTINEL-NEGATIVE-HEADER',
      items: [pricedItem({ id: undefined, code: 'SENTINEL-NEGATIVE-CODE', desc: 'SENTINEL-NEGATIVE-DESC', total: -1 })],
    }]),
    (error: unknown) => {
      assert.ok(error instanceof RangeError)
      assert.match(error.message, /non-negative/i)
      assert.match(error.message, /section index 1/)
      assert.match(error.message, /item index 1/)
      assert.doesNotMatch(error.message, /SENTINEL-NEGATIVE-(?:HEADER|CODE|DESC)/)
      return true
    },
  )
})

test('rejects aggregate overflow with the section and 1-based item index', () => {
  const items = [
    pricedItem({ id: undefined, total: Number.MAX_VALUE }),
    pricedItem({ id: undefined, total: Number.MAX_VALUE }),
  ]

  assert.throws(
    () => calculateBoqTotals([{ header: 'SENTINEL-OVERFLOW-HEADER', items }]),
    (error: unknown) => {
      assert.ok(error instanceof RangeError)
      assert.match(error.message, /grand total.*finite/i)
      assert.match(error.message, /section index 1/)
      assert.match(error.message, /item index 2/)
      assert.doesNotMatch(error.message, /SENTINEL-OVERFLOW-HEADER/)
      return true
    },
  )
})

test('rejects an invalid total even when the priced option is excluded', () => {
  const excluded = pricedItem({
    total: Number.NaN,
    optional: true,
    excludedFromTotal: true,
  })

  assert.throws(
    () => calculateBoqTotals([{ header: 'Options', items: [excluded] }]),
    /finite/i,
  )
})
