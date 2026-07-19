import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import { compareBoqToCatalog, formatHistoricalVariance } from './boq-catalog-comparison'

const now = '2026-07-16T00:00:00.000Z'
const standard: StandardEntry = { id: 'std-1', description: 'Ready-mix concrete C30', unit: 'm3', aliases: ['Concrete C30'], sourceBoqCount: 2, createdAt: now, updatedAt: now }
function boq(id: string, rate: number, stdId?: string): Boq {
  return { id, project: id, vendor: id, workType: 'Structural', date: '2026-07-16', totalItems: 1, grandTotal: rate, status: 'approved', stdStatus: stdId ? 'complete' : 'none', createdAt: now, updatedAt: now, sections: [{ header: 'Work', items: [{ id: `${id}-item`, desc: 'Concrete C30', unit: 'm3', qty: 1, rate, total: rate, type: 'unit', stdStatus: stdId ? 'matched' : 'unmatched', ...(stdId ? { stdId } : {}) }] }] }
}

test('compares one BOQ row to a compatible catalog candidate and rates from other BOQs', () => {
  const result = compareBoqToCatalog(boq('target', 120, 'std-1'), [standard], [boq('target', 120, 'std-1'), boq('old-1', 100, 'std-1'), boq('old-2', 110, 'std-1')])
  assert.equal(result.rows[0]?.candidate?.standardId, 'std-1')
  assert.deepEqual(result.rows[0]?.benchmark, { count: 2, min: 100, average: 105, max: 110 })
  assert.equal(result.rows[0]?.variancePct, 14.285714285714285)
})

test('legacy unmatched target can show a candidate but not a historical baseline', () => {
  const target = boq('target', 120)
  const result = compareBoqToCatalog(target, [standard], [target, boq('old-1', 100, 'std-1')])

  assert.equal(result.rows[0]?.candidate?.standardId, 'std-1')
  assert.equal(result.rows[0]?.benchmark, null)
  assert.equal(result.rows[0]?.variancePct, null)
})

test('does not invent a catalog match when text has no overlap', () => {
  const target = boq('target', 120)
  target.sections[0].items[0].desc = 'Mobilisation allowance'
  assert.equal(compareBoqToCatalog(target, [standard], [target]).rows[0]?.candidate, null)
})

test('historical benchmark uses only matched items from approved BOQs', () => {
  const draft = boq('draft', 10, 'std-1')
  draft.status = 'draft'
  const unmatched = boq('unmatched', 20, 'std-1')
  unmatched.sections[0].items[0].stdStatus = 'unmatched'
  const excluded = boq('excluded', 30, 'std-1')
  excluded.sections[0].items[0].stdStatus = 'excluded'
  const approved = boq('approved', 100, 'std-1')

  const result = compareBoqToCatalog(boq('target', 88, 'std-1'), [standard], [draft, unmatched, excluded, approved])

  assert.deepEqual(result.rows[0]?.benchmark, { count: 1, min: 100, average: 100, max: 100 })
  assert.equal(result.rows[0]?.variancePct, -12)
})

test('formats historical variance in plain language', () => {
  assert.equal(formatHistoricalVariance(-12), '12.0% below average')
  assert.equal(formatHistoricalVariance(8.44), '8.4% above average')
  assert.equal(formatHistoricalVariance(0.04), 'At average')
  assert.equal(formatHistoricalVariance(null), 'No historical baseline')
})

test('comparison skips informational bundle children but retains excluded priced options', () => {
  const target = boq('target', 120, 'std-1')
  target.sections[0].items.push({
    id: 'bundle-child',
    pricingRole: 'bundle_child',
    parentBundleId: 'target-item',
    desc: 'Pump body',
    stdStatus: 'pending',
  })
  target.sections[0].items.push({
    id: 'option',
    desc: 'Optional controls',
    unit: 'item',
    qty: 1,
    rate: 50,
    total: 50,
    type: 'unit',
    optional: true,
    excludedFromTotal: true,
    stdStatus: 'unmatched',
  })

  const result = compareBoqToCatalog(target, [standard], [target])
  assert.deepEqual(result.rows.map((row) => row.item.id), ['target-item', 'option'])
})
