import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqPricedItem } from './boq-schema'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import type { Estimate } from './estimate-schema'
import type { StandardEntry } from './standard-schema'
import {
  CatalogMergeError,
  parseCatalogMergeInput,
  planCatalogMerge,
  planCatalogMergeUndo,
  previewCatalogMerge,
  type MergeAwareStandard,
} from './catalog-merge'

const now = '2026-10-25T10:00:00.000Z'

function std(id: string, description: string, unit = 'm', extra: Partial<StandardEntry> = {}): StandardEntry {
  return { id, description, unit, aliases: [], sourceBoqCount: 0, sourceItems: [], createdAt: now, updatedAt: now, ...extra }
}

function row(id: string, stdId: string, rate: number): BoqPricedItem {
  return { id, desc: `row ${id}`, unit: 'm', qty: 1, rate, total: rate, type: 'unit', stdStatus: 'matched', stdId, stdMatch: 'x' }
}

function boq(id: string, items: BoqPricedItem[], status: Boq['status'] = 'approved'): Boq {
  return {
    id, project: 'P', vendor: `V-${id}`, workType: 'MEP', date: '2026-10-01', totalItems: items.length,
    grandTotal: items.reduce((sum, item) => sum + item.total, 0), status, stdStatus: 'complete',
    sections: [{ header: 'S', items }], createdAt: now, updatedAt: now,
  }
}

const standards = [
  std('a', 'PVC pipe 4"', 'm', { aliases: ['pipe 4'], sourceItems: [{ boqId: 'b1', sectionIndex: 0, itemId: 'r1', sourceDescription: 'pipe' }], sourceBoqCount: 1 }),
  std('b', 'PVC Pipe 4 inch', 'เมตร', { sourceItems: [{ boqId: 'b2', sectionIndex: 0, itemId: 'r2', sourceDescription: 'pipe' }], sourceBoqCount: 1 }),
  std('c', 'Elbow 4"', 'ea'),
]
const boqs = [boq('b1', [row('r1', 'a', 100)]), boq('b2', [row('r2', 'b', 200), row('r3', 'c', 50)])]
const estimates: Estimate[] = [{
  id: 'e1', name: 'E', date: '2026-10-01', status: 'draft', totalAmount: 0, createdAt: now, updatedAt: now,
  items: [{ stdId: 'b', desc: 'pipe', unit: 'm', qty: 1, rate: 1, total: 1 } as Estimate['items'][number]],
}]
const rules: HumanApprovedCatalogConversionRule[] = [
  { id: 'rule-1', sourceUnit: 'เส้น', catalogUnit: 'm', catalogUnitsPerSourceUnit: '4' as never, scope: 'catalog_item', catalogId: 'b', version: 1, approvedBy: 'u', approvedAt: now },
]

test('parse requires a kept item and at least one other', () => {
  assert.throws(() => parseCatalogMergeInput({ keepId: 'a', mergeIds: ['a'] }), CatalogMergeError)
  assert.throws(() => parseCatalogMergeInput({ mergeIds: ['a', 'b'] }), CatalogMergeError)
  assert.deepEqual(parseCatalogMergeInput({ keepId: 'a', mergeIds: ['a', 'b', 'b'] }).mergeIds, ['b'])
})

test('merge keeps chosen fields, unions sources, repoints rows/estimates/conversions and archives the rest', () => {
  const plan = planCatalogMerge({
    standards, boqs, estimates, rules, now, mappings: [{ id: 'm1', catalogId: 'b' }, { id: 'm2', catalogId: 'c' }],
    input: { keepId: 'a', mergeIds: ['b'], description: 'PVC pipe 4 inch', unit: 'm', aliases: [] },
  })
  assert.deepEqual(plan.mappings, [{ id: 'm1', catalogId: 'a' }])
  assert.equal(plan.kept.description, 'PVC pipe 4 inch')
  assert.deepEqual(plan.kept.aliases.sort(), ['pipe 4', 'PVC pipe 4"'].sort())
  assert.equal(plan.kept.sourceItems?.length, 2)
  assert.equal(plan.kept.sourceBoqCount, 2)
  assert.equal(plan.archived.length, 1)
  assert.equal(plan.archived[0]!.archivedAt, now)
  assert.equal(plan.archived[0]!.mergedInto, 'a')
  assert.equal(plan.boqs.length, 1)
  assert.equal(plan.boqs[0]!.sections[0]!.items[0]!.stdId, 'a')
  assert.equal((plan.boqs[0]!.sections[0]!.items[0] as BoqPricedItem).stdMatch, 'PVC pipe 4 inch')
  assert.equal(plan.boqs[0]!.sections[0]!.items[1]!.stdId, 'c', 'unrelated rows untouched')
  assert.equal(plan.estimates[0]!.items[0]!.stdId, 'a')
  assert.equal(plan.rules[0]!.catalogId, 'a')
  assert.equal(plan.rules[0]!.version, 2)
  assert.equal(plan.undo.rows.length, 1)
})

test('merge refuses a name+unit that clashes with an entry outside the merge, and archived entries', () => {
  assert.throws(
    () => planCatalogMerge({ standards, boqs, now, input: { keepId: 'a', mergeIds: ['b'], description: 'elbow 4"', unit: 'ea', aliases: [] } }),
    (error: unknown) => error instanceof CatalogMergeError && error.status === 409,
  )
  const withArchived = [...standards, std('d', 'old', 'm', { archivedAt: now })]
  assert.throws(
    () => planCatalogMerge({ standards: withArchived, boqs, now, input: { keepId: 'a', mergeIds: ['d'], description: '', unit: '', aliases: [] } }),
    (error: unknown) => error instanceof CatalogMergeError && error.status === 409,
  )
})

test('preview combines price history of all picked entries', () => {
  const preview = previewCatalogMerge({ standards, boqs, rules, input: { keepId: 'a', mergeIds: ['b'], description: '', unit: '', aliases: [] } })
  assert.equal(preview.entries.length, 2)
  assert.equal(preview.entries[0]!.history?.count, 1)
  assert.equal(preview.combined?.count, 2)
  assert.equal(preview.combined?.average, 150)
  assert.equal(preview.linkedRows, 2)
  assert.equal(preview.conversions, 1)
  assert.equal(preview.unitsDiffer, false, 'm and เมตร are the same unit')
  assert.ok(preview.suggested.aliases.includes('PVC Pipe 4 inch'))
})

test('undo restores the kept entry, unarchives the others and points rows back', () => {
  const plan = planCatalogMerge({
    standards, boqs, estimates, rules, now, mappings: [{ id: 'm1', catalogId: 'b' }],
    input: { keepId: 'a', mergeIds: ['b'], description: 'PVC pipe 4 inch', unit: 'm', aliases: [] },
  })
  const after: MergeAwareStandard[] = [plan.kept, ...plan.archived, standards[2]!]
  const afterBoqs = boqs.map((b) => plan.boqs.find((next) => next.id === b.id) ?? b)
  const undo = planCatalogMergeUndo({ standards: after, boqs: afterBoqs, estimates: plan.estimates, rules: plan.rules, mappings: plan.mappings, keepId: 'a', now })
  assert.deepEqual(undo.mappings, [{ id: 'm1', catalogId: 'b' }])
  assert.equal(undo.kept.description, 'PVC pipe 4"')
  assert.equal(undo.kept.sourceItems?.length, 1)
  assert.equal(undo.kept.lastMerge, undefined)
  assert.equal(undo.restored[0]!.archivedAt, undefined)
  assert.equal(undo.restored[0]!.mergedInto, undefined)
  assert.equal(undo.boqs[0]!.sections[0]!.items[0]!.stdId, 'b')
  assert.equal((undo.boqs[0]!.sections[0]!.items[0] as BoqPricedItem).stdMatch, 'PVC Pipe 4 inch')
  assert.equal(undo.estimates[0]!.items[0]!.stdId, 'b')
  assert.equal(undo.rules[0]!.catalogId, 'b')
  assert.throws(() => planCatalogMergeUndo({ standards, boqs, keepId: 'a', now }), CatalogMergeError)
})
