import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyManualCostAllocation,
  deriveSourceCostAllocation,
  costAllocationReconciles,
} from './boq-cost-allocation'
import type { BoqItem, BoqPricedItem } from './boq-schema'

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return {
    id: 'item-1',
    desc: 'Concrete',
    unit: 'm3',
    qty: 3,
    rate: 100,
    total: 300,
    type: 'unit',
    costComponent: 'combined',
    stdStatus: 'unmatched',
    ...overrides,
  }
}

test('derives a source rate allocation when material and labour share quantity and unit', () => {
  const allocation = deriveSourceCostAllocation(item({
    sourceCosts: {
      material: { present: true, qty: 3, unit: 'm3', rate: 60, total: 180 },
      labour: { present: true, qty: 3, unit: 'm3', rate: 40, total: 120 },
    },
  }))

  assert.deepEqual(allocation, {
    basis: 'rate',
    material: 60,
    labour: 40,
    origin: 'source',
  })
})

test('derives explicit one-component source rows without inventing a combined split', () => {
  assert.deepEqual(deriveSourceCostAllocation(item({ costComponent: 'material' })), {
    basis: 'rate', material: 100, labour: 0, origin: 'source',
  })
  assert.deepEqual(deriveSourceCostAllocation(item({ costComponent: 'labour' })), {
    basis: 'rate', material: 0, labour: 100, origin: 'source',
  })
  assert.equal(deriveSourceCostAllocation(item({ costComponent: 'combined', sourceCosts: undefined })), undefined)
})

test('manual unit allocation derives the combined rate and total', () => {
  const updated = applyManualCostAllocation(item(), 65, 45)

  assert.deepEqual(updated.costAllocation, {
    basis: 'rate', material: 65, labour: 45, origin: 'manual',
  })
  assert.equal(updated.rate, 110)
  assert.equal(updated.total, 330)
  assert.equal(costAllocationReconciles(updated), true)
})

test('manual lump-sum allocation derives total and rate', () => {
  const updated = applyManualCostAllocation(item({ type: 'lump_sum', qty: 1, unit: 'L/S' }), 200, 150)

  assert.deepEqual(updated.costAllocation, {
    basis: 'total', material: 200, labour: 150, origin: 'manual',
  })
  assert.equal(updated.total, 350)
  assert.equal(updated.rate, 350)
  assert.equal(costAllocationReconciles(updated), true)
})

test('rejects non-finite and negative manual component values', () => {
  assert.throws(() => applyManualCostAllocation(item(), -1, 10), /non-negative/i)
  assert.throws(() => applyManualCostAllocation(item(), Number.NaN, 10), /finite/i)
})

test('informational bundle children are never assigned invented cost allocations', () => {
  const child: BoqItem = {
    id: 'bundle-child',
    pricingRole: 'bundle_child',
    parentBundleId: 'bundle',
    desc: 'Pump body',
    stdStatus: 'pending',
  }

  assert.equal(deriveSourceCostAllocation(child), undefined)
  assert.throws(() => applyManualCostAllocation(child, 60, 40), /priced BOQ item/i)
})
