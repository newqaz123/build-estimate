import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqItem } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { applyBoqItemUpdates, countBoqStandardLinks, parseUpdateGroups } from './route'
import { createBoqDetailHandlers } from '../route'

const timestamps = {
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
}

function item(overrides: Partial<BoqItem> = {}): BoqItem {
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
  return {
    id,
    project: id,
    vendor: 'Vendor',
    workType: 'Structural',
    date: '2026-07-13',
    totalItems: items.length,
    grandTotal: items.reduce((sum, current) => sum + current.total, 0),
    status: 'active',
    stdStatus: 'complete',
    sections: [{ header: 'Concrete', items }],
    ...timestamps,
  }
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

  const first = result.boqs[0]?.sections[0]?.items[0]
  const second = result.boqs[1]?.sections[0]?.items[0]
  const unrelated = result.boqs[2]?.sections[0]?.items[0]
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

function detailBoq(overrides: Partial<Boq> = {}): Boq {
  return {
    ...boq('boq-1', [item()]),
    sourceFileName: 'source.pdf',
    sourceStoragePath: 'boqs/boq-1/source.pdf',
    sourceTotal: 200,
    ...overrides,
  }
}

function detailHarness(existing: Boq = detailBoq()) {
  const updates: Record<string, unknown>[] = []
  const calls: string[] = []
  let current: Boq | null = existing
  let sourceError: unknown
  const handlers = createBoqDetailHandlers({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => current,
    updateBoq: async (_id, update) => {
      updates.push(update)
      current = current ? { ...current, ...update } as Boq : null
    },
    deleteBoq: async () => { calls.push('db') },
    deleteSource: async () => {
      calls.push('source')
      if (sourceError) throw sourceError
    },
  })
  return { handlers, updates, calls, setSourceError: (error: unknown) => { sourceError = error } }
}

const detailContext = { params: Promise.resolve({ id: 'boq-1' }) }

test('approval builds and verifies the candidate while recomputing section totals', async () => {
  const harness = detailHarness()
  const sections = [{ header: 'Concrete', items: [item({ qty: 2, rate: 100, total: 200 })] }]

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved', sections, grandTotal: 999_999 }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates[0]?.status, 'approved')
  assert.equal(harness.updates[0]?.totalItems, 1)
  assert.equal(harness.updates[0]?.grandTotal, 200)
  assert.equal('sourceStoragePath' in (await response.json()), false)
})

test('approval rejects every blocking local verification category with structured details', async (t) => {
  const cases: [string, Partial<Boq>, Record<string, unknown>][] = [
    ['unclassified', { workType: 'Unclassified' }, { status: 'approved' }],
    ['blank vendor', { vendor: ' ' }, { status: 'approved' }],
    ['blank project', { project: '' }, { status: 'approved' }],
    ['blank date', { date: '' }, { status: 'approved' }],
    ['empty items', {}, { status: 'approved', sections: [] }],
    ['invalid numbers', {}, { status: 'approved', sections: [{ header: 'Bad', items: [item({ qty: Number.NaN })] }] }],
    ['grand total mismatch', { grandTotal: 199 }, { status: 'approved' }],
    ['source total mismatch', { sourceTotal: 199 }, { status: 'approved' }],
  ]

  for (const [name, existing, update] of cases) {
    await t.test(name, async () => {
      const harness = detailHarness(detailBoq(existing))
      const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
        method: 'PUT',
        body: JSON.stringify(update),
      }), detailContext)
      const body = await response.json()
      assert.equal(response.status, 400)
      assert.equal(typeof body.error, 'string')
      assert.equal(body.verification.hasBlockingIssues, true)
      assert.equal(harness.updates.length, 0)
    })
  }
})

test('non-approval updates may retain verification warnings and unclassified work', async () => {
  const harness = detailHarness(detailBoq({ workType: 'Unclassified' }))
  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'draft', sections: [{ header: 'Allowance', items: [item({ qty: 0, rate: 0, total: 0 })] }] }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates.length, 1)
})

test('DELETE removes source before Firestore and preserves Firestore when source deletion fails', async (t) => {
  await t.test('source first', async () => {
    const harness = detailHarness()
    const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
    assert.equal(response.status, 200)
    assert.deepEqual(harness.calls, ['source', 'db'])
  })

  await t.test('source failure', async () => {
    const harness = detailHarness()
    harness.setSourceError(new Error('bucket secret'))
    const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'The BOQ source could not be deleted. The BOQ was not deleted.' })
    assert.deepEqual(harness.calls, ['source'])
  })

  await t.test('missing source is helper-handled', async () => {
    const harness = detailHarness()
    harness.setSourceError({ code: 404 })
    const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
    assert.equal(response.status, 200)
    assert.deepEqual(harness.calls, ['source', 'db'])
  })
})

test('DELETE still removes BOQs without a source reference', async () => {
  const harness = detailHarness(detailBoq({ sourceStoragePath: undefined }))
  const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
  assert.equal(response.status, 200)
  assert.deepEqual(harness.calls, ['db'])
})
