import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq, BoqPricedItem } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import { ApprovalError, NO_CATALOG_ITEM_REASON, planApproval, planReopen } from './boq-approval'
import { buildCatalogHistoricalPricing } from './catalog-historical-pricing'

const NOW = '2026-10-25T12:00:00.000Z'

function item(id: string, desc: string, unit: string, qty: number, rate: number, extra: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return { id, desc, unit, qty, rate, total: qty * rate, type: 'unit', stdStatus: 'unmatched', ...extra }
}

function boq(extra: Partial<Boq> = {}): Boq {
  const sections = [{ header: 'Works', items: [item('a', 'Steel pipe 2in', 'm', 10, 100), item('b', 'Paint', 'm2', 5, 20)] }]
  return {
    id: 'q1', project: 'P', vendor: 'V', workType: 'Unclassified', date: '2026-10-01',
    totalItems: 2, grandTotal: 1100, status: 'draft', stdStatus: 'none', sections,
    createdAt: NOW, updatedAt: NOW, ...extra,
  }
}

function standard(id: string, description: string, unit: string, extra: Partial<StandardEntry> = {}): StandardEntry {
  return { id, description, unit, aliases: [], sourceItems: [], sourceBoqCount: 0, createdAt: NOW, updatedAt: NOW, ...extra }
}

test('planApproval links chosen rows, marks the rest No catalog item, and approves', () => {
  const plan = planApproval({
    boq: boq(),
    standards: [standard('s-pipe', 'Steel pipe', 'm')],
    choices: [{ sectionIndex: 0, itemIndex: 0, itemId: 'a', standardId: 's-pipe', confidence: 'fuzzy' }],
    now: NOW,
  })
  assert.deepEqual(plan.blocking, [])
  assert.equal(plan.boq.status, 'approved')
  assert.equal(plan.boq.approvedAt, NOW)
  assert.equal(plan.linked, 1)
  assert.equal(plan.noCatalog, 1)
  const [a, b] = plan.boq.sections[0]!.items as BoqPricedItem[]
  assert.equal(a!.stdId, 's-pipe')
  assert.equal(a!.stdStatus, 'matched')
  assert.equal(a!.stdConfidence, 'fuzzy')
  assert.equal(a!.desc, 'Steel pipe 2in', 'keeps the quote wording')
  assert.equal(b!.stdStatus, 'excluded')
  assert.equal(b!.stdExclusionReason, NO_CATALOG_ITEM_REASON)
  assert.equal(plan.boq.stdStatus, 'complete')
  assert.equal(plan.standards.length, 1)
  assert.deepEqual(plan.standards[0]!.sourceItems, [{ boqId: 'q1', sectionIndex: 0, itemId: 'a', sourceDescription: 'Steel pipe 2in' }])
  assert.equal(plan.standards[0]!.sourceBoqCount, 1)
})

test('approved choices feed price history; nothing does before Approve', () => {
  const standards = [standard('s-pipe', 'Steel pipe', 'm')]
  const draft = boq()
  assert.equal(buildCatalogHistoricalPricing(standards, [draft]).size, 0)
  const plan = planApproval({ boq: draft, standards, choices: [{ sectionIndex: 0, itemIndex: 0, standardId: 's-pipe' }], now: NOW })
  const history = buildCatalogHistoricalPricing(plan.standards, [plan.boq])
  assert.equal(history.get('s-pipe')?.count, 1)
  assert.equal(history.get('s-pipe')?.average, 100)
})

test('choosing No catalog item clears an earlier link and its source entry', () => {
  const linked = boq()
  linked.sections[0]!.items[0] = item('a', 'Steel pipe 2in', 'm', 10, 100, { stdStatus: 'matched', stdId: 's-pipe', stdMatch: 'Steel pipe' })
  const standards = [standard('s-pipe', 'Steel pipe', 'm', {
    sourceItems: [{ boqId: 'q1', sectionIndex: 0, itemId: 'a', sourceDescription: 'x' }, { boqId: 'other', sectionIndex: 0, itemId: 'z', sourceDescription: 'y' }],
    sourceBoqCount: 2,
  })]
  const plan = planApproval({ boq: linked, standards, choices: [{ sectionIndex: 0, itemIndex: 0, standardId: null }], now: NOW })
  const a = plan.boq.sections[0]!.items[0] as BoqPricedItem
  assert.equal(a.stdStatus, 'excluded')
  assert.equal(a.stdId, undefined)
  assert.deepEqual(plan.standards[0]!.sourceItems!.map((s) => s.boqId), ['other'])
  assert.equal(plan.standards[0]!.sourceBoqCount, 1)
})

test('rows without a choice keep an existing link', () => {
  const linked = boq()
  linked.sections[0]!.items[1] = item('b', 'Paint', 'm2', 5, 20, { stdStatus: 'matched', stdId: 's-paint', stdConfidence: 'exact' })
  const plan = planApproval({ boq: linked, standards: [standard('s-paint', 'Paint', 'm2')], choices: [], now: NOW })
  assert.equal((plan.boq.sections[0]!.items[1] as BoqPricedItem).stdId, 's-paint')
  assert.equal(plan.linked, 1)
})

test('total mismatches and unclassified work type are notes, not blockers', () => {
  const draft = boq({ sourceTotal: 999 })
  draft.sections[0]!.items[0] = { ...item('a', 'Steel pipe', 'm', 10, 100), total: 1001 }
  const plan = planApproval({ boq: draft, standards: [], choices: [], now: NOW })
  assert.deepEqual(plan.blocking, [])
  assert.ok(plan.notes.some((note) => /quantity multiplied by rate/.test(note.message)))
  assert.ok(plan.notes.some((note) => /workType/.test(note.message)))
  assert.equal(plan.boq.grandTotal, 1101, 'totals are recomputed from rows')
})

test('broken data blocks Approve', () => {
  const draft = boq({ vendor: '' })
  draft.sections[0]!.items[1] = item('b', '', 'm2', 5, 20)
  const plan = planApproval({ boq: draft, standards: [], choices: [], now: NOW })
  assert.ok(plan.blocking.some((p) => /vendor/.test(p.message)))
  assert.ok(plan.blocking.some((p) => /description/.test(p.message) && p.itemIndex === 1))
})

test('unit that does not fit the catalog is linked with a plain note', () => {
  const plan = planApproval({ boq: boq(), standards: [standard('s-pipe', 'Steel pipe', 'kg')], choices: [{ sectionIndex: 0, itemIndex: 0, standardId: 's-pipe' }], now: NOW })
  assert.equal(plan.linked, 1)
  assert.ok(plan.notes.some((note) => /price history/.test(note.message) && note.itemIndex === 0))
})

test('planApproval rejects stale or invalid input', () => {
  assert.throws(() => planApproval({ boq: boq({ status: 'approved' }), standards: [], choices: [], now: NOW }), (e: unknown) => e instanceof ApprovalError && e.status === 409)
  assert.throws(() => planApproval({ boq: boq(), standards: [], choices: [{ sectionIndex: 0, itemIndex: 0, itemId: 'zzz', standardId: null }], now: NOW }), /changed/)
  assert.throws(() => planApproval({ boq: boq(), standards: [], choices: [{ sectionIndex: 0, itemIndex: 0, standardId: 'nope' }], now: NOW }), /not found/)
  assert.throws(() => planApproval({ boq: boq(), standards: [], choices: [{ sectionIndex: 3, itemIndex: 0, standardId: null }], now: NOW }), /does not exist/)
  assert.throws(() => planApproval({ boq: boq(), standards: [standard('s', 'S', 'm', { archivedAt: NOW })], choices: [{ sectionIndex: 0, itemIndex: 0, standardId: 's' }], now: NOW }), /not found/)
})

test('planReopen removes the quote from price history until approved again', () => {
  const standards = [standard('s-pipe', 'Steel pipe', 'm')]
  const approved = planApproval({ boq: boq(), standards, choices: [{ sectionIndex: 0, itemIndex: 0, standardId: 's-pipe' }], now: NOW })
  const reopened = planReopen({ boq: approved.boq, standards: approved.standards, now: '2026-10-26T00:00:00.000Z' })
  assert.equal(reopened.boq.status, 'review')
  assert.equal(reopened.boq.approvedAt, undefined)
  assert.equal(reopened.boq.reopenedAt, '2026-10-26T00:00:00.000Z')
  assert.equal((reopened.boq.sections[0]!.items[0] as BoqPricedItem).stdId, 's-pipe', 'keeps the choice for the next Approve')
  assert.deepEqual(reopened.standards[0]!.sourceItems, [])
  assert.equal(buildCatalogHistoricalPricing(reopened.standards, [reopened.boq]).size, 0)
  assert.throws(() => planReopen({ boq: boq(), standards: [], now: NOW }), /Only approved/)
})
