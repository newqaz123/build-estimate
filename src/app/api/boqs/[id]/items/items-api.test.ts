import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqItem, BoqPricedItem } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { applyBoqItemUpdates, countBoqStandardLinks, parseUpdateGroups } from './item-updates'
import { readFileSync } from 'node:fs'
import { calculateBoqTotals, isPricedBoqItem } from '@/lib/boq-pricing'

const timestamps = {
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
}

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return {
    code: 'A-1',
    desc: 'Source concrete',
    unit: 'm3',
    qty: 2,
    rate: 100,
    total: 200,
    type: 'unit',
    stdStatus: 'matched',
    ...overrides,
  }
}

function boq(id: string, items: BoqItem[]): Boq {
  const totals = calculateBoqTotals([{ header: 'Concrete', items }])
  return {
    id,
    project: id,
    vendor: 'Vendor',
    workType: 'Structural',
    date: '2026-07-13',
    ...totals,
    status: 'active',
    stdStatus: 'complete',
    sections: [{ header: 'Concrete', items }],
    ...timestamps,
  }
}

function priced(value: BoqItem | undefined): BoqPricedItem {
  assert.ok(value && isPricedBoqItem(value))
  return value
}

function standard(overrides: Partial<StandardEntry> = {}): StandardEntry {
  return {
    id: 'std-1',
    description: 'Source concrete',
    unit: 'm3',
    aliases: [],
    sourceItems: [],
    sourceBoqCount: 0,
    ...timestamps,
    ...overrides,
  }
}

test('production item route delegates parsing and updates to the tested pure module', () => {
  const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')
  assert.match(source, /from ['"]\.\/item-updates['"]/)
  assert.match(source, /parseUpdateGroups\(body\)/)
  assert.match(source, /applyBoqItemUpdates\(/)
  assert.doesNotMatch(source, /function (?:parseUpdateGroups|applyBoqItemUpdates|cloneItemWithUpdate)\b/)
})

test('production item route persists user-entered missing rows with an audit record', () => {
  const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')
  assert.match(source, /export async function POST/)
  assert.match(source, /addMissingBoqItem/)
  assert.match(source, /manual-entry-audit/)
  assert.match(source, /entryOrigin/)
})

test('linked canonical edits update the standard and every linked BOQ item atomically', () => {
  const result = applyBoqItemUpdates(
    [
      boq('boq-1', [
        item({ sourceDesc: 'Raw concrete one', sourceUnit: 'm3', stdId: 'std-1' }),
      ]),
      boq('boq-2', [
        item({ code: 'B-1', qty: 8, rate: 250, total: 2000, sourceDesc: 'Raw concrete two', sourceUnit: 'm³', stdId: 'std-1' }),
      ]),
      boq('boq-3', [item({ code: 'C-1', stdId: 'std-other', desc: 'Other item' })]),
    ],
    [standard({
      sourceItems: [
        { boqId: 'boq-1', sectionIndex: 0, itemCode: 'A-1', sourceDescription: 'Raw concrete one' },
        { boqId: 'boq-2', sectionIndex: 0, itemCode: 'B-1', sourceDescription: 'Raw concrete two' },
      ],
      sourceBoqCount: 2,
    })],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', desc: 'Ready-mix concrete', unit: 'm³', qty: 5 }] }],
  )

  assert.equal(result.affectedItems, 2)
  assert.equal(result.affectedBoqs, 2)
  assert.equal(result.standards[0]?.description, 'Ready-mix concrete')
  assert.equal(result.standards[0]?.unit, 'm³')

  const first = priced(result.boqs[0]?.sections[0]?.items[0])
  const second = priced(result.boqs[1]?.sections[0]?.items[0])
  const unrelated = priced(result.boqs[2]?.sections[0]?.items[0])
  assert.equal(first?.desc, 'Ready-mix concrete')
  assert.equal(first?.unit, 'm³')
  assert.equal(first?.qty, 5)
  assert.equal(first?.rate, 100)
  assert.equal(first?.total, 500)
  assert.equal(first?.stdId, 'std-1')
  assert.equal(first?.sourceDesc, 'Raw concrete one')
  assert.equal(first?.sourceUnit, 'm3')
  assert.equal(second?.desc, 'Ready-mix concrete')
  assert.equal(second?.unit, 'm³')
  assert.equal(second?.qty, 8)
  assert.equal(second?.rate, 250)
  assert.equal(second?.total, 2000)
  assert.equal(second?.sourceDesc, 'Raw concrete two')
  assert.equal(unrelated?.desc, 'Other item')
  assert.equal(unrelated?.unit, 'm3')
})

test('canonical sync assigns manual confidence to a linked legacy row without confidence', () => {
  const result = applyBoqItemUpdates(
    [
      boq('boq-1', [item({ stdId: 'std-1' })]),
      boq('boq-legacy', [item({ desc: 'Source concrete', unit: 'm3', stdConfidence: undefined })]),
    ],
    [standard({ sourceItems: [{ boqId: 'boq-legacy', sectionIndex: 0, itemCode: 'A-1', sourceDescription: 'Source concrete' }] })],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', desc: 'Canonical concrete' }] }],
  )

  assert.equal(priced(result.boqs[1]?.sections[0]?.items[0]).stdConfidence, 'manual')
})

test('unlinked BOQ edits remain local and do not mutate the standard catalog', () => {
  const result = applyBoqItemUpdates(
    [
      boq('boq-1', [item({ stdStatus: 'unmatched', desc: 'Local concrete' })]),
      boq('boq-2', [item({ code: 'B-1', stdId: 'std-1', desc: 'Source concrete' })]),
    ],
    [standard()],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', desc: 'Local revision', unit: 'kg', qty: 4, rate: 12 }] }],
  )

  assert.equal(result.affectedItems, 0)
  assert.equal(result.affectedBoqs, 1)
  assert.equal(result.standards[0]?.description, 'Source concrete')
  assert.equal(result.standards[0]?.unit, 'm3')
  assert.deepEqual(result.boqs[0]?.sections[0]?.items[0], item({ stdStatus: 'unmatched', desc: 'Local revision', unit: 'kg', qty: 4, rate: 12, total: 48 }))
  assert.deepEqual(result.boqs[1]?.sections[0]?.items[0], item({ code: 'B-1', stdId: 'std-1', desc: 'Source concrete' }))
})

test('approved BOQs reject component PATCH mutations', () => {
  const approved = { ...boq('boq-approved', [item()]), status: 'approved' as const }
  assert.throws(
    () => applyBoqItemUpdates([approved], [], approved.id, [{ sectionIndex: 0, items: [{ itemCode: 'A-1', materialCost: 70, labourCost: 50 }] }]),
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 409,
  )
})

test('canonical PATCH cannot propagate a linked standard mutation into an approved BOQ', () => {
  const source = boq('boq-source', [item({ stdId: 'std-1' })])
  const approved = { ...boq('boq-approved', [item({ code: 'B-1', stdId: 'std-1' })]), status: 'approved' as const }
  assert.throws(
    () => applyBoqItemUpdates([source, approved], [standard()], source.id, [{ sectionIndex: 0, items: [{ itemCode: 'A-1', desc: 'Changed canonical' }] }]),
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 409,
  )
})

test('full material and labour edits persist a manual allocation and reconcile the row rate', () => {
  const result = applyBoqItemUpdates(
    [boq('boq-1', [item({ stdStatus: 'unmatched' })])],
    [],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', materialCost: 70, labourCost: 50 }] }],
  )
  const updated = priced(result.boqs[0]?.sections[0]?.items[0])
  assert.deepEqual(updated?.costAllocation, { basis: 'rate', material: 70, labour: 50, origin: 'manual' })
  assert.equal(updated?.rate, 120)
  assert.equal(updated?.total, 240)
})

test('partial material PATCH preserves source-derived labour and marks origin manual', () => {
  const result = applyBoqItemUpdates(
    [boq('boq-1', [item({
      stdStatus: 'unmatched',
      sourceCosts: {
        material: { present: true, qty: 2, unit: 'm3', rate: 60, total: 120 },
        labour: { present: true, qty: 2, unit: 'm3', rate: 40, total: 80 },
      },
    })])],
    [],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', materialCost: 80 }] }],
  )
  const updated = priced(result.boqs[0]?.sections[0]?.items[0])
  assert.deepEqual(updated?.costAllocation, { basis: 'rate', material: 80, labour: 40, origin: 'manual' })
  assert.equal(updated?.rate, 120)
  assert.equal(updated?.total, 240)
})

test('partial labour PATCH against an existing manual allocation preserves material', () => {
  const result = applyBoqItemUpdates(
    [boq('boq-1', [item({
      stdStatus: 'unmatched',
      costAllocation: { basis: 'rate', material: 70, labour: 50, origin: 'manual' },
    })])],
    [],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', labourCost: 60 }] }],
  )
  const updated = priced(result.boqs[0]?.sections[0]?.items[0])
  assert.deepEqual(updated?.costAllocation, { basis: 'rate', material: 70, labour: 60, origin: 'manual' })
  assert.equal(updated?.rate, 130)
  assert.equal(updated?.total, 260)
})

test('lump-sum component allocation uses totals and derives rate from quantity', () => {
  const result = applyBoqItemUpdates(
    [boq('boq-1', [item({
      stdStatus: 'unmatched',
      type: 'lump_sum',
      qty: 1,
      rate: 5000,
      total: 5000,
    })])],
    [],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', materialCost: 3000, labourCost: 2000 }] }],
  )
  const updated = priced(result.boqs[0]?.sections[0]?.items[0])
  assert.deepEqual(updated?.costAllocation, { basis: 'total', material: 3000, labour: 2000, origin: 'manual' })
  assert.equal(updated?.rate, 5000)
  assert.equal(updated?.total, 5000)
})

test('excluding an item requires a reason and clears its catalog link', () => {
  assert.throws(
    () => parseUpdateGroups({ sectionIndex: 0, items: [{ itemCode: 'A-1', stdStatus: 'excluded' }] }),
    /exclusion reason/i,
  )

  const result = applyBoqItemUpdates(
    [boq('boq-1', [item({ stdId: 'std-1', stdMatch: 'Source concrete', stdConfidence: 'manual' })])],
    [standard()],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', stdStatus: 'excluded', stdExclusionReason: 'One-off provisional sum' }] }],
  )
  const updated = result.boqs[0]?.sections[0]?.items[0]

  assert.equal(updated?.stdStatus, 'excluded')
  assert.equal(updated?.stdExclusionReason, 'One-off provisional sum')
  assert.equal(updated?.stdId, undefined)
  assert.equal(updated?.stdMatch, undefined)
  assert.equal(updated?.stdConfidence, undefined)
  assert.equal(result.boqs[0]?.stdStatus, 'complete')
})

test('an excluded optional item can be explicitly included in totals', () => {
  const result = applyBoqItemUpdates(
    [boq('boq-1', [item({ optional: true, excludedFromTotal: true, stdStatus: 'unmatched' })])],
    [],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemCode: 'A-1', excludedFromTotal: false }] }],
  )
  const updated = priced(result.boqs[0]?.sections[0]?.items[0])
  assert.equal(updated.excludedFromTotal, false)
  assert.equal(result.boqs[0]?.grandTotal, 200)
  assert.throws(
    () => applyBoqItemUpdates([boq('boq-1', [item({ optional: false })])], [], 'boq-1', [{ sectionIndex: 0, items: [{ itemCode: 'A-1', excludedFromTotal: true }] }]),
    /optional/i,
  )
})

test('same-standard partial edits compose canonical fields across one batch', () => {
  const result = applyBoqItemUpdates(
    [
      boq('boq-1', [
        item({ code: 'A-1', stdId: 'std-1', sourceDesc: 'Raw A', sourceUnit: 'm3' }),
        item({ code: 'A-2', stdId: 'std-1', sourceDesc: 'Raw B', sourceUnit: 'm3' }),
      ]),
    ],
    [standard()],
    'boq-1',
    [{
      sectionIndex: 0,
      items: [
        { itemCode: 'A-1', desc: 'Ready-mix concrete' },
        { itemCode: 'A-2', unit: 'm³' },
      ],
    }],
  )

  assert.equal(result.standards[0]?.description, 'Ready-mix concrete')
  assert.equal(result.standards[0]?.unit, 'm³')
  for (const linked of result.boqs[0]?.sections[0]?.items ?? []) {
    assert.ok(isPricedBoqItem(linked))
    assert.equal(linked.desc, 'Ready-mix concrete')
    assert.equal(linked.unit, 'm³')
  }
})

test('malformed PATCH payload values are rejected with 400 validation errors', () => {
  const malformedPayloads: unknown[] = [
    { sectionIndex: 0, items: null },
    { sectionIndex: 0, items: [] },
    { sectionIndex: 0, items: [null] },
    { sectionIndex: 0, items: [{ itemCode: null }] },
    { sectionIndex: 0, items: [{ itemCode: 'A-1', stdStatus: 'invalid' }] },
    { sectionIndex: 0, items: [{ itemCode: 'A-1', stdMatch: null }] },
    { sectionIndex: '0', items: [{ itemCode: 'A-1' }] },
    { updates: 'not-an-array' },
  ]

  for (const payload of malformedPayloads) {
    assert.throws(
      () => parseUpdateGroups(payload),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 400,
    )
  }
})

test('component monetary values reject negatives, NaN, Infinity and sub-cent precision', () => {
  const invalidValues: unknown[] = [
    { sectionIndex: 0, items: [{ itemCode: 'A-1', materialCost: -1 }] },
    { sectionIndex: 0, items: [{ itemCode: 'A-1', labourCost: Number.NaN }] },
    { sectionIndex: 0, items: [{ itemCode: 'A-1', materialCost: Number.POSITIVE_INFINITY }] },
    { sectionIndex: 0, items: [{ itemCode: 'A-1', labourCost: 12.345 }] },
  ]

  for (const payload of invalidValues) {
    assert.throws(
      () => parseUpdateGroups(payload),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 400,
    )
  }
})

test('informational bundle children reject component mutations', () => {
  const bundle = {
    id: 'bundle-child-1',
    code: undefined,
    desc: 'Bundle child',
    pricingRole: 'bundle_child' as const,
    parentBundleId: 'bundle-parent-1',
    stdStatus: 'excluded' as const,
  }
  assert.throws(
    () => applyBoqItemUpdates(
      [boq('boq-1', [bundle])],
      [],
      'boq-1',
      [{ sectionIndex: 0, items: [{ itemId: 'bundle-child-1', materialCost: 50 }] }],
    ),
    /informational|read-only numeric/i,
  )
})

test('standard link impact counts scanned direct links and legacy provenance rows', () => {
  const impact = countBoqStandardLinks(
    [
      boq('boq-direct', [item({ stdId: 'std-1' })]),
      boq('boq-legacy', [item({ stdStatus: 'matched', desc: 'Old canonical', unit: 'old-unit' })]),
      boq('boq-unrelated', [item({ stdId: 'std-other', desc: 'Other item' })]),
    ],
    standard({
      description: 'Current canonical',
      unit: 'unit',
      sourceItems: [
        { boqId: 'boq-legacy', sectionIndex: 0, itemCode: 'A-1', sourceDescription: 'Old canonical' },
        { boqId: 'boq-stale', sectionIndex: 0, itemCode: 'MISSING', sourceDescription: 'Gone' },
      ],
    }),
  )

  assert.deepEqual(impact, { affectedLinkCount: 2, affectedBoqCount: 2 })
})

test('code-less imported items update by internal ID', () => {
  const result = applyBoqItemUpdates(
    [boq('boq-1', [item({ id: 'item-1', code: undefined })])],
    [],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemId: 'item-1', qty: 7, rate: 3 }] }],
  )

  assert.equal(priced(result.boqs[0]?.sections[0]?.items[0]).total, 21)
})

test('duplicate legacy codes are ambiguous while an internal ID selects one item', () => {
  const duplicateItems = [
    item({ id: 'item-1', code: 'DUP', desc: 'First' }),
    item({ id: 'item-2', code: 'DUP', desc: 'Second' }),
  ]

  assert.throws(
    () => applyBoqItemUpdates(
      [boq('boq-1', duplicateItems)],
      [],
      'boq-1',
      [{ sectionIndex: 0, items: [{ itemCode: 'DUP', desc: 'Wrong' }] }],
    ),
    /ambiguous/i,
  )

  const result = applyBoqItemUpdates(
    [boq('boq-1', duplicateItems)],
    [],
    'boq-1',
    [{ sectionIndex: 0, items: [{ itemId: 'item-2', itemCode: 'DUP', desc: 'Selected' }] }],
  )
  assert.equal(result.boqs[0]?.sections[0]?.items[0]?.desc, 'First')
  assert.equal(result.boqs[0]?.sections[0]?.items[1]?.desc, 'Selected')
})

test('request validation requires one non-empty item identity', () => {
  for (const payload of [
    { sectionIndex: 0, items: [{ desc: 'Missing' }] },
    { sectionIndex: 0, items: [{ itemId: '' }] },
    { sectionIndex: 0, items: [{ itemId: null }] },
  ]) {
    assert.throws(() => parseUpdateGroups(payload), /identity|itemId/i)
  }
})

test('link impact counts code-less linked items distinctly by internal ID', () => {
  const impact = countBoqStandardLinks(
    [boq('boq-1', [
      item({ id: 'item-1', code: undefined, stdId: 'std-1' }),
      item({ id: 'item-2', code: undefined, stdId: 'std-1' }),
    ])],
    standard(),
  )

  assert.deepEqual(impact, { affectedLinkCount: 2, affectedBoqCount: 1 })
})
