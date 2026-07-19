import test from 'node:test'
import assert from 'node:assert/strict'
import { deleteBoqItemAndPruneStandards, pruneBoqFromStandards } from './boq-deletion'
import type { Boq } from './boq-schema'
import type { StandardEntry } from './standard-schema'

function boq(): Boq {
  return {
    id: 'boq-1', project: 'Project', vendor: 'Vendor', workType: 'Structural', date: '2026-07-16',
    totalItems: 2, grandTotal: 300, status: 'approved', stdStatus: 'partial', createdAt: '', updatedAt: '',
    sections: [{ header: 'Works', items: [
      { id: 'item-1', desc: 'Concrete', unit: 'm3', qty: 1, rate: 100, total: 100, type: 'unit', stdStatus: 'matched', stdId: 'std-1' },
      { id: 'item-2', desc: 'Steel', unit: 'kg', qty: 2, rate: 100, total: 200, type: 'unit', stdStatus: 'unmatched' },
    ] }],
  }
}

function standard(): StandardEntry {
  return {
    id: 'std-1', description: 'Concrete', unit: 'm3', aliases: [], sourceBoqCount: 2,
    sourceItems: [
      { boqId: 'boq-1', sectionIndex: 0, itemId: 'item-1', sourceDescription: 'Concrete' },
      { boqId: 'boq-2', sectionIndex: 0, itemId: 'item-x', sourceDescription: 'Concrete' },
    ], createdAt: '', updatedAt: '',
  }
}

test('deletes one item, removes empty sections, recomputes totals, and prunes exact provenance', () => {
  const result = deleteBoqItemAndPruneStandards(boq(), [standard()], 0, { itemId: 'item-1' })

  assert.equal(result.boq.totalItems, 1)
  assert.equal(result.boq.grandTotal, 200)
  assert.equal(result.boq.stdStatus, 'none')
  assert.deepEqual(result.standards[0].sourceItems?.map((source) => source.boqId), ['boq-2'])
  assert.equal(result.standards[0].sourceBoqCount, 1)
})

test('does not permit deleting the final BOQ item', () => {
  const single = boq()
  single.sections[0].items = [single.sections[0].items[0]]
  single.totalItems = 1
  assert.throws(() => deleteBoqItemAndPruneStandards(single, [standard()], 0, { itemId: 'item-1' }), /entire BOQ/i)
})

test('whole BOQ pruning removes every source entry and recomputes unique source BOQ count', () => {
  const result = pruneBoqFromStandards('boq-1', [standard()])
  assert.deepEqual(result[0].sourceItems?.map((source) => source.boqId), ['boq-2'])
  assert.equal(result[0].sourceBoqCount, 1)
})

test('pending informational children do not leave a matched BOQ partially standardized after deletion', () => {
  const input = boq()
  input.sections[0].items.push({
    id: 'bundle-child',
    pricingRole: 'bundle_child',
    parentBundleId: 'item-1',
    desc: 'Included component',
    stdStatus: 'pending',
  })

  const result = deleteBoqItemAndPruneStandards(input, [standard()], 0, { itemId: 'item-2' })

  assert.equal(result.boq.totalItems, 1)
  assert.equal(result.boq.stdStatus, 'complete')
})

test('allows deleting an informational child when only one priced parent remains', () => {
  const input = boq()
  input.sections[0].items = [input.sections[0].items[0], {
    id: 'child', pricingRole: 'bundle_child', parentBundleId: 'item-1', desc: 'Included', stdStatus: 'pending',
  }]
  input.totalItems = 1
  const result = deleteBoqItemAndPruneStandards(input, [standard()], 0, { itemId: 'child' })
  assert.equal(result.boq.totalItems, 1)
  assert.deepEqual(result.boq.sections[0].items.map((item) => item.id), ['item-1'])
})

test('rejects deleting a bundle parent while children still reference it', () => {
  const input = boq()
  input.sections[0].items.push({
    id: 'child', pricingRole: 'bundle_child', parentBundleId: 'item-1', desc: 'Included', stdStatus: 'pending',
  })
  assert.throws(() => deleteBoqItemAndPruneStandards(input, [standard()], 0, { itemId: 'item-1' }), /bundle children/i)
})

test('derives priced count instead of trusting stale totalItems', () => {
  const input = boq()
  input.totalItems = 1
  const result = deleteBoqItemAndPruneStandards(input, [standard()], 0, { itemId: 'item-2' })
  assert.equal(result.boq.totalItems, 1)
})

test('protects the final priced row even when informational rows remain', () => {
  const input = boq()
  input.sections[0].items = [input.sections[0].items[0], {
    id: 'child', pricingRole: 'bundle_child', parentBundleId: 'item-1', desc: 'Included', stdStatus: 'pending',
  }]
  input.totalItems = 99
  assert.throws(() => deleteBoqItemAndPruneStandards(input, [standard()], 0, { itemId: 'item-1' }), /final priced|entire BOQ/i)
})
