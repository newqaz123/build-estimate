import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqItem } from './boq-schema'
import { getBoqCatalogReadiness } from './boq-catalog-readiness'

const now = '2026-07-17T00:00:00.000Z'

function item(overrides: Partial<BoqItem> = {}): BoqItem {
  return {
    id: 'item-1',
    desc: 'Stainless steel pipe 6 inch',
    unit: 'm',
    qty: 10,
    rate: 100,
    total: 1000,
    type: 'unit',
    stdStatus: 'pending',
    ...overrides,
  }
}

function boq(items: BoqItem[]): Boq {
  return {
    id: 'boq-1', project: 'Plant extension', vendor: 'Vendor A', workType: 'MEP',
    date: '2026-07-17', totalItems: items.length, grandTotal: 1000,
    status: 'draft', stdStatus: 'partial', sections: [{ header: 'Pipework', items }],
    createdAt: now, updatedAt: now,
  }
}

test('catalog readiness resolves matched items only when they have a catalog id', () => {
  const result = getBoqCatalogReadiness(boq([
    item({ id: 'linked', stdStatus: 'matched', stdId: 'std-1' }),
    item({ id: 'broken-link', stdStatus: 'matched', stdId: undefined }),
  ]))

  assert.equal(result.total, 2)
  assert.equal(result.resolved, 1)
  assert.equal(result.blocking, 1)
  assert.equal(result.items[0]?.itemId, 'broken-link')
})

test('catalog readiness requires a reason before an excluded item is resolved', () => {
  const result = getBoqCatalogReadiness(boq([
    item({ id: 'excluded', stdStatus: 'excluded', stdExclusionReason: 'One-off provisional allowance' }),
    item({ id: 'missing-reason', stdStatus: 'excluded', stdExclusionReason: '   ' }),
  ]))

  assert.equal(result.resolved, 1)
  assert.equal(result.blocking, 1)
  assert.equal(result.items[0]?.reason, 'Exclusion reason is required')
})

test('catalog readiness ignores non-priced structural rows', () => {
  const result = getBoqCatalogReadiness(boq([
    item({ id: 'heading', desc: 'Pipework', qty: 0, rate: 0, total: 0, stdStatus: 'pending' }),
    item({ id: 'priced', stdStatus: 'matched', stdId: 'std-1' }),
  ]))

  assert.deepEqual(result, { total: 1, resolved: 1, blocking: 0, items: [] })
})
