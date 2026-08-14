import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqPricedItem } from '@/lib/boq-schema'
import { fingerprintCanonicalSections } from '@/lib/boq-extraction-proposals'
import type { ActionableReviewStage } from '@/lib/settings-schema'
import { createBoqDetailHandlers } from './[id]/handler'
import { createSourceHandler } from './[id]/source/handler'

function sourceBoq(overrides: Partial<Boq> = {}): Boq {
  return {
    id: 'boq-1',
    project: 'Tower',
    vendor: 'Acme',
    workType: 'Structural',
    date: '2026-07-15',
    totalItems: 1,
    grandTotal: 200,
    status: 'draft',
    stdStatus: 'none',
    sections: [],
    sourceFileName: 'Acme quote.pdf',
    sourceStoragePath: 'boqs/boq-1/source.pdf',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  }
}

const context = { params: Promise.resolve({ id: 'boq-1' }) }

test('source GET requires authentication', async () => {
  const GET = createSourceHandler({
    authenticate: async () => null,
    getBoq: async () => sourceBoq(),
    loadSource: async () => Buffer.from('unused'),
  })

  const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)

  assert.equal(response.status, 401)
})

test('source GET returns 404 for a missing BOQ or storage path', async (t) => {
  for (const [name, stored] of [
    ['missing BOQ', null],
    ['missing path', sourceBoq({ sourceStoragePath: undefined })],
  ] as const) {
    await t.test(name, async () => {
      const GET = createSourceHandler({
        authenticate: async () => ({ user: {} }),
        getBoq: async () => stored,
        loadSource: async () => Buffer.from('unused'),
      })
      const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)
      assert.equal(response.status, 404)
    })
  }
})

test('source GET maps a missing storage object to 404 and other load failures to a generic 500', async (t) => {
  for (const [name, error, status] of [
    ['missing object', { code: 404 }, 404],
    ['storage failure', new Error('secret bucket details'), 500],
  ] as const) {
    await t.test(name, async (t) => {
      if (status === 500) t.mock.method(console, 'error', () => {})
      const GET = createSourceHandler({
        authenticate: async () => ({ user: {} }),
        getBoq: async () => sourceBoq(),
        loadSource: async () => { throw error },
      })
      const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)
      assert.equal(response.status, status)
      if (status === 500) assert.deepEqual(await response.json(), { error: 'Internal server error' })
    })
  }
})

test('source GET streams exact private PDF bytes with a safe inline filename and no public URL', async () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
  let loadedPath = ''
  const GET = createSourceHandler({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => sourceBoq({ sourceFileName: 'quote "หนึ่ง".pdf' }),
    loadSource: async (path) => {
      loadedPath = path
      return bytes
    },
  })

  const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)

  assert.equal(response.status, 200)
  assert.equal(loadedPath, 'boqs/boq-1/source.pdf')
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const disposition = response.headers.get('content-disposition') ?? ''
  assert.match(disposition, /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/)
  assert.doesNotMatch(disposition, /[\r\n]/)
  assert.equal(response.headers.get('location'), null)
  assert.doesNotMatch([...response.headers.values()].join(' '), /firebase|storage\.googleapis|https?:\/\//i)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
})

test('source GET safely encodes filenames containing lone UTF-16 surrogates', async () => {
  const GET = createSourceHandler({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => sourceBoq({ sourceFileName: 'hostile-\uD800.pdf' }),
    loadSource: async () => Buffer.from('%PDF'),
  })

  const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''hostile-%EF%BF%BD\.pdf/)
})

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
    stdId: 'std-1',
    ...overrides,
  }
}

function detailBoq(overrides: Partial<Boq> = {}): Boq {
  return {
    ...sourceBoq(),
    sections: [{ header: 'Concrete', items: [item()] }],
    sourceTotal: 200,
    ...overrides,
  }
}

function detailHarness(existing: Boq = detailBoq()) {
  const updates: Record<string, unknown>[] = []
  const calls: string[] = []
  const logs: { message: string; error: unknown }[] = []
  const saved: { path: string; bytes: Buffer }[] = []
  const sourceBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
  let current: Boq | null = existing
  const failures: { load?: unknown; source?: unknown; db?: unknown; save?: unknown } = {}
  const handlers = createBoqDetailHandlers({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => current,
    updateBoq: async (_id, prepareUpdate) => {
      if (!current) return 'not-found'
      const decision = prepareUpdate(current)
      if (decision.kind === 'rejected') return decision
      updates.push(decision.updates)
      current = { ...current, ...decision.updates } as Boq
      return 'updated'
    },
    loadSource: async () => {
      calls.push('load')
      if (failures.load) throw failures.load
      return sourceBytes
    },
    deleteSource: async () => {
      calls.push('source')
      if (failures.source) throw failures.source
    },
    deleteBoq: async () => {
      calls.push('db')
      if (failures.db) throw failures.db
      current = null
    },
    saveSource: async (path, bytes) => {
      calls.push('save')
      if (failures.save) throw failures.save
      saved.push({ path, bytes: Buffer.from(bytes) })
    },
    logError: (message, error) => { logs.push({ message, error }) },
  })
  return { handlers, updates, calls, logs, saved, sourceBytes, failures }
}

const detailContext = { params: Promise.resolve({ id: 'boq-1' }) }

function quoteSummaryFixture() {
  return {
    directWorkTotal: '179400',
    overheadProfitAmount: '35880',
    quotedSubtotal: '215280',
    discountAmount: '1280',
    payableTotal: '214000',
  }
}

function quoteSummaryDirectItems(): BoqPricedItem[] {
  const direct: Array<[string, string, number]> = [
    ['item-1', 'Concrete work', 25_000],
    ['item-2', 'Formwork', 25_000],
    ['item-3', 'Rebar', 25_000],
    ['item-4', 'Excavation', 25_000],
    ['item-5', 'Backfilling', 25_000],
    ['item-6', 'Drainage', 25_000],
    ['item-7', 'Finishing work', 29_400],
  ]
  return direct.map(([id, desc, total], index) =>
    item({
      id,
      desc,
      unit: 'item',
      qty: 1,
      rate: total,
      total,
      stdId: `std-${index + 1}`,
    }),
  )
}

function quoteSummaryBoq(overrides: Partial<Boq> = {}): Boq {
  return detailBoq({
    sections: [{ header: 'Direct Works', items: quoteSummaryDirectItems() }],
    totalItems: 7,
    grandTotal: 179_400,
    sourceTotal: 215_280,
    sourceQuoteSummary: quoteSummaryFixture(),
    ...overrides,
  })
}

test('approval builds and verifies the candidate while recomputing section totals', async () => {
  const harness = detailHarness()
  const sections = [{ header: 'Concrete', items: [item()] }]
  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved', sections, grandTotal: 999_999 }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates[0]?.grandTotal, 200)
  const body = await response.json()
  assert.equal('sourceStoragePath' in body, false)
  assert.equal(body.sourceAvailable, true)
})

test('approval accepts a reconciled source quote summary', async () => {
  const harness = detailHarness(quoteSummaryBoq())

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved' }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates[0]?.status, 'approved')
  assert.equal(harness.updates[0]?.grandTotal, 179_400)
  const body = await response.json()
  assert.deepEqual(body.sourceQuoteSummary, quoteSummaryFixture())
})

test('approval rejects a tampered source quote summary', async () => {
  const harness = detailHarness(
    quoteSummaryBoq({
      sourceQuoteSummary: { ...quoteSummaryFixture(), overheadProfitAmount: '35881' },
    }),
  )

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved' }),
  }), detailContext)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error, 'Resolve required BOQ fields before approval')
  assert.equal(body.verification.hasBlockingIssues, true)
  assert.ok(body.verification.issues.some(
    (issue: { code: string }) => issue.code === 'quote_subtotal_mismatch',
  ))
  assert.equal(harness.updates.length, 0)
})

test('draft PUT cannot replace immutable sourceQuoteSummary', async () => {
  const harness = detailHarness(quoteSummaryBoq())

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({
      status: 'draft',
      project: 'Edited project',
      sourceQuoteSummary: { directWorkTotal: '1', quotedSubtotal: '1' },
    }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates.some((update) => 'sourceQuoteSummary' in update), false)
  const body = await response.json()
  assert.equal(body.project, 'Edited project')
  assert.deepEqual(body.sourceQuoteSummary, quoteSummaryFixture())
})

test('approval still requires catalog matches for direct priced items beside a quote summary', async () => {
  const items = quoteSummaryDirectItems()
  const withPending = items.map((priced, index) =>
    index === items.length - 1
      ? { ...priced, stdStatus: 'pending' as const, stdId: undefined }
      : priced,
  )
  const harness = detailHarness(
    quoteSummaryBoq({ sections: [{ header: 'Direct Works', items: withPending }] }),
  )

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved' }),
  }), detailContext)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error, 'Resolve catalog items before approval')
  assert.equal(body.catalogReadiness.blocking, 1)
  assert.equal(body.catalogReadiness.items[0]?.itemId, 'item-7')
  assert.equal(harness.updates.length, 0)
})

test('approved quote-summary BOQs still return 409 for attempted updates', async () => {
  const stored = quoteSummaryBoq({ status: 'approved', project: 'Approved project' })
  const handlers = createBoqDetailHandlers({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => stored,
    updateBoq: async () => 'approved',
    deleteBoq: async () => {},
    loadSource: async () => Buffer.from('%PDF'),
    deleteSource: async () => {},
    saveSource: async () => {},
    logError: () => {},
  })

  const response = await handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'draft', project: 'Stale draft project' }),
  }), detailContext)

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'Approved BOQs are read-only' })
})

test('approval validates the transaction snapshot after a concurrent draft mutation', async () => {
  const preRead = detailBoq()
  let stored = detailBoq({ vendor: ' ' })
  let transactionAttempted = false
  const handlers = createBoqDetailHandlers({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => preRead,
    updateBoq: async (_id, prepareUpdate) => {
      transactionAttempted = true
      assert.equal(typeof prepareUpdate, 'function')
      const decision = prepareUpdate(stored)
      if (decision.kind === 'rejected') return decision
      stored = { ...stored, ...decision.updates } as Boq
      return 'updated'
    },
    deleteBoq: async () => {},
    loadSource: async () => Buffer.from('%PDF'),
    deleteSource: async () => {},
    saveSource: async () => {},
    logError: () => {},
  })

  const response = await handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved' }),
  }), detailContext)

  assert.equal(transactionAttempted, true)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'Resolve required BOQ fields before approval')
  assert.equal(stored.status, 'draft')
  assert.equal(stored.vendor, ' ')
})

test('approval reparses stored sections when the partial PUT omits sections', async (t) => {
  const malformed = [
    [{ header: 'Pump', items: [
      item({ id: 'parent', pricingRole: 'bundle_parent' }),
      { id: 'child', pricingRole: 'bundle_child', parentBundleId: 'parent', desc: 'Body', stdStatus: 'pending', costAllocation: { basis: 'rate', material: 1, labour: 2, origin: 'manual' } },
    ] }],
    [{ header: 'Pump', items: [item({ optional: false, excludedFromTotal: true, exclusionReason: 'Invalid option' })] }],
  ]
  for (const sections of malformed) {
    await t.test('rejects malformed stored sections', async () => {
      const harness = detailHarness(detailBoq({ sections: sections as Boq['sections'] }))
      const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
        method: 'PUT', body: JSON.stringify({ status: 'approved' }),
      }), detailContext)
      assert.equal(response.status, 400)
      assert.equal(harness.updates.length, 0)
    })
  }

  await t.test('accepts and persists recalculated legacy priced sections', async () => {
    const harness = detailHarness(detailBoq({ totalItems: 99, grandTotal: 999 }))
    const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
      method: 'PUT', body: JSON.stringify({ status: 'approved' }),
    }), detailContext)
    assert.equal(response.status, 200)
    assert.equal(harness.updates[0]?.totalItems, 1)
    assert.equal(harness.updates[0]?.grandTotal, 200)
    assert.deepEqual(harness.updates[0]?.sections, detailBoq().sections)
  })
})

test('approval rejects every blocking local verification category with structured details', async (t) => {
  const cases: [string, Partial<Boq>, Record<string, unknown>][] = [
    ['unclassified', {}, { status: 'approved', workType: 'Unclassified' }],
    ['blank vendor', { vendor: ' ' }, { status: 'approved' }],
    ['blank project', { project: '' }, { status: 'approved' }],
    ['blank date', { date: '' }, { status: 'approved' }],
    ['empty items', {}, { status: 'approved', sections: [] }],
    ['invalid numbers', {}, { status: 'approved', sections: [{ header: 'Bad', items: [item({ qty: Number.NaN })] }] }],
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
      if (name === 'invalid numbers') {
        assert.match(body.error, /must be a finite non-negative number/)
      } else {
        assert.equal(body.error, 'Resolve required BOQ fields before approval')
        assert.equal(body.verification.hasBlockingIssues, true)
      }
      assert.equal(harness.updates.length, 0)
    })
  }
})

test('approval rejects unresolved priced catalog items with item-level details', async () => {
  const harness = detailHarness(detailBoq({
    sections: [{ header: 'Concrete', items: [item({ id: 'pending-item', stdStatus: 'pending', stdId: undefined })] }],
  }))

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved' }),
  }), detailContext)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error, 'Resolve catalog items before approval')
  assert.equal(body.catalogReadiness.blocking, 1)
  assert.equal(body.catalogReadiness.items[0].itemId, 'pending-item')
  assert.equal(harness.updates.length, 0)
})

test('approval accepts an excluded priced item with a reason', async () => {
  const harness = detailHarness(detailBoq({
    sections: [{ header: 'Concrete', items: [item({ stdStatus: 'excluded', stdId: undefined, stdExclusionReason: 'One-off allowance' })] }],
  }))

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved' }),
  }), detailContext)

  assert.equal(response.status, 200)
})

test('approval counts only priced rows and totals only contributing rows', async () => {
  const sections: Boq['sections'] = [{
    header: 'Pump package',
    items: [
      item({ id: 'bundle', pricingRole: 'bundle_parent', qty: 1, total: 95_200, rate: 95_200 }),
      { id: 'child', pricingRole: 'bundle_child', parentBundleId: 'bundle', desc: 'Pump body', stdStatus: 'pending' },
      item({ id: 'option', desc: 'Optional controls', qty: 1, total: 10_000, rate: 10_000, optional: true, excludedFromTotal: true, exclusionReason: 'Optional alternate', stdStatus: 'excluded', stdId: undefined, stdExclusionReason: 'Optional alternate' }),
    ],
  }]
  const harness = detailHarness(detailBoq({ sections, grandTotal: 95_200, sourceTotal: 95_200 }))

  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved', sections }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates[0]?.totalItems, 2)
  assert.equal(harness.updates[0]?.grandTotal, 95_200)
})

test('draft updates may explicitly save Unclassified work and retain verification warnings', async () => {
  const harness = detailHarness()
  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({
      status: 'draft',
      workType: 'Unclassified',
      sections: [{ header: 'Allowance', items: [item({ qty: 0, rate: 0, total: 0 })] }],
    }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates[0]?.workType, 'Unclassified')
})

test('stale PUT after approval returns 409 without overwriting the approved BOQ', async () => {
  const draft = detailBoq()
  let stored = detailBoq({ status: 'approved', project: 'Approved project' })
  let initialRead = true
  const handlers = createBoqDetailHandlers({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => {
      if (initialRead) {
        initialRead = false
        return draft
      }
      return stored
    },
    updateBoq: async (_id, prepareUpdate) => {
      if (stored.status === 'approved') return 'approved'
      const decision = prepareUpdate(stored)
      if (decision.kind === 'rejected') return decision
      stored = { ...stored, ...decision.updates } as Boq
      return 'updated'
    },
    deleteBoq: async () => {},
    loadSource: async () => Buffer.from('%PDF'),
    deleteSource: async () => {},
    saveSource: async () => {},
    logError: () => {},
  })

  const response = await handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'draft', project: 'Stale draft project' }),
  }), detailContext)

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'Approved BOQs are read-only' })
  assert.equal(stored.status, 'approved')
  assert.equal(stored.project, 'Approved project')
})

test('invalid workType validation lists Unclassified as an accepted value', async () => {
  const harness = detailHarness()
  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ workType: 'Civil' }),
  }), detailContext)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'workType must be Structural, MEP, Finishing, or Unclassified',
  })
})

test('PUT rejects malformed canonical section payloads before persistence', async () => {
  for (const sections of [
    [{ header: 'Pump', items: [{ id: 'child', pricingRole: 'bundle_child', parentBundleId: 'missing', desc: 'Body', stdStatus: 'pending' }] }],
    [{ header: 'Pump', items: [{ ...item(), optional: 'yes' }] }],
    [{ header: 'Pump', items: [{ ...item(), optional: false, excludedFromTotal: true, exclusionReason: 'Arbitrary' }] }],
    [{ header: 'Pump', items: [item({ id: 'one', total: Number.MAX_VALUE }), item({ id: 'two', total: Number.MAX_VALUE })] }],
  ]) {
    const harness = detailHarness()
    const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
      method: 'PUT', body: JSON.stringify({ status: 'draft', sections }),
    }), detailContext)
    assert.equal(response.status, 400)
    assert.equal(harness.updates.length, 0)
  }
})

test('PUT rejects explicit null sections instead of treating them as omitted', async () => {
  const harness = detailHarness()
  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT', body: JSON.stringify({ status: 'draft', sections: null }),
  }), detailContext)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'sections must be an array.' })
  assert.equal(harness.updates.length, 0)
})

test('DELETE caches exact source bytes before source and Firestore deletion', async () => {
  const harness = detailHarness()
  const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)

  assert.equal(response.status, 200)
  assert.deepEqual(harness.calls, ['load', 'source', 'db'])
})

test('DELETE treats a source missing during cache or deletion as absent', async (t) => {
  await t.test('missing during cache', async () => {
    const harness = detailHarness()
    harness.failures.load = { code: 404 }
    const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
    assert.equal(response.status, 200)
    assert.deepEqual(harness.calls, ['load', 'db'])
  })

  await t.test('missing during deletion', async () => {
    const harness = detailHarness()
    harness.failures.source = { code: 404 }
    const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
    assert.equal(response.status, 200)
    assert.deepEqual(harness.calls, ['load', 'source', 'db'])
  })
})

test('DELETE does not remove Firestore when source caching or deletion fails', async (t) => {
  for (const [phase, failure, expectedCalls] of [
    ['cache', { load: new Error('load failed') }, ['load']],
    ['delete', { source: new Error('delete failed') }, ['load', 'source']],
  ] as const) {
    await t.test(phase, async () => {
      const harness = detailHarness()
      Object.assign(harness.failures, failure)
      const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
      assert.equal(response.status, 500)
      assert.deepEqual(harness.calls, expectedCalls)
    })
  }
})

test('DELETE restores exact cached bytes when Firestore deletion fails', async () => {
  const dbError = new Error('firestore unavailable')
  const harness = detailHarness()
  harness.failures.db = dbError
  const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Internal server error' })
  assert.deepEqual(harness.calls, ['load', 'source', 'db', 'save'])
  assert.equal(harness.saved[0]?.path, 'boqs/boq-1/source.pdf')
  assert.deepEqual(harness.saved[0]?.bytes, harness.sourceBytes)
  assert.ok(harness.logs.some((entry) => entry.error === dbError))
})

test('DELETE logs a failed restore while retaining the generic Firestore error response', async () => {
  const restoreError = new Error('restore failed')
  const harness = detailHarness()
  harness.failures.db = new Error('firestore unavailable')
  harness.failures.save = restoreError
  const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Internal server error' })
  assert.deepEqual(harness.calls, ['load', 'source', 'db', 'save'])
  assert.equal(harness.saved.length, 0)
  assert.ok(harness.logs.some((entry) => /restore/i.test(entry.message) && entry.error === restoreError))
})

test('DELETE still removes BOQs without a source reference', async () => {
  const harness = detailHarness(detailBoq({ sourceStoragePath: undefined }))
  const response = await harness.handlers.DELETE(new Request('http://localhost/api/boqs/boq-1', { method: 'DELETE' }), detailContext)
  assert.equal(response.status, 200)
  assert.deepEqual(harness.calls, ['db'])
})

// Actionable extraction review is read inside the approval transaction (mirrors
// route.ts) and blocks approval when suggestions are pending or the snapshot is
// stale. The harness reads the latest snapshot fresh each transaction attempt.
interface TestActionableSnapshot {
  generatedAt: string
  versions: { boqSectionsFingerprint: string }
  actionableItemSuggestions: { status: string }[]
}

function makeActionableSnapshot(
  generatedAt: string,
  boqSectionsFingerprint: string,
  suggestions: { status: string }[],
): TestActionableSnapshot {
  return {
    generatedAt,
    versions: { boqSectionsFingerprint },
    actionableItemSuggestions: suggestions,
  }
}

function readActionableBlocking(
  boq: Boq,
  snapshots: TestActionableSnapshot[],
): { pending: number; stale: boolean } | null {
  const runId = boq.activeExtractionRunId
  if (!runId || snapshots.length === 0) return null
  const latest = [...snapshots].sort((a, b) =>
    b.generatedAt.localeCompare(a.generatedAt),
  )[0]!
  const pending = latest.actionableItemSuggestions.filter(
    (suggestion) => suggestion.status === 'pending',
  ).length
  const stale =
    latest.versions.boqSectionsFingerprint !== fingerprintCanonicalSections(boq.sections)
  return { pending, stale }
}

const ACTIONABLE_BLOCKING_STAGES: ReadonlySet<ActionableReviewStage> = new Set([
  'focused',
  'add_and_match',
  'default',
])

function actionableBlockingForStage(
  stage: ActionableReviewStage,
  boq: Boq,
  snapshots: TestActionableSnapshot[],
): { pending: number; stale: boolean } | null {
  if (!ACTIONABLE_BLOCKING_STAGES.has(stage)) return null
  return readActionableBlocking(boq, snapshots)
}

function actionableApprovalHarness(
  boq: Boq,
  snapshots: TestActionableSnapshot[],
  stage: ActionableReviewStage = 'focused',
  onTransaction?: (boq: Boq, snapshots: TestActionableSnapshot[]) => void,
) {
  let current = boq
  let attempts = 0
  const handlers = createBoqDetailHandlers({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => current,
    updateBoq: async (_id, prepareUpdate) => {
      attempts += 1
      if (onTransaction) onTransaction(current, snapshots)
      const decision = prepareUpdate(current, actionableBlockingForStage(stage, current, snapshots))
      if (decision.kind === 'rejected') return decision
      current = { ...current, ...decision.updates } as Boq
      return 'updated'
    },
    deleteBoq: async () => {},
    loadSource: async () => Buffer.from('%PDF'),
    deleteSource: async () => {},
    saveSource: async () => {},
    logError: () => {},
  })
  return { handlers, attempts: () => attempts, current: () => current }
}

function approveRequest() {
  return new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved' }),
  })
}

test('approval blocks when the latest actionable snapshot has a pending suggestion', async () => {
  const boq = detailBoq({ activeExtractionRunId: 'run-1' })
  const liveFingerprint = fingerprintCanonicalSections(boq.sections)
  const { handlers } = actionableApprovalHarness(boq, [
    makeActionableSnapshot('2026-01-01T00:00:00.000Z', liveFingerprint, [
      { status: 'pending' },
      { status: 'added_matched' },
    ]),
  ])

  const response = await handlers.PUT(approveRequest(), detailContext)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error, 'Resolve pending extraction review before approval')
  assert.equal(body.actionableReview.pending, 1)
  assert.equal(body.actionableReview.stale, false)
  assert.equal(body.verification.hasBlockingIssues, false)
  assert.equal(body.catalogReadiness.blocking, 0)
  assert.equal(boq.status, 'draft')
})

test('approval blocks when the latest actionable snapshot is stale against the live BOQ', async () => {
  const boq = detailBoq({ activeExtractionRunId: 'run-1' })
  const { handlers } = actionableApprovalHarness(boq, [
    makeActionableSnapshot('2026-01-01T00:00:00.000Z', 'sha256:stale-fingerprint', [
      { status: 'added_matched' },
    ]),
  ])

  const response = await handlers.PUT(approveRequest(), detailContext)
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error, 'Resolve pending extraction review before approval')
  assert.equal(body.actionableReview.pending, 0)
  assert.equal(body.actionableReview.stale, true)
  assert.equal(boq.status, 'draft')
})

test('approval succeeds when there is no active extraction run or generated snapshot', async () => {
  const boq = detailBoq()
  const harness = actionableApprovalHarness(boq, [])

  const response = await harness.handlers.PUT(approveRequest(), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.current().status, 'approved')
})

test('approval succeeds when actionable review stage is off despite a pending snapshot', async () => {
  const boq = detailBoq({ activeExtractionRunId: 'run-1' })
  const liveFingerprint = fingerprintCanonicalSections(boq.sections)
  const harness = actionableApprovalHarness(
    boq,
    [makeActionableSnapshot('2026-01-01T00:00:00.000Z', liveFingerprint, [{ status: 'pending' }])],
    'off',
  )

  const response = await harness.handlers.PUT(approveRequest(), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.current().status, 'approved')
})

test('approval succeeds when actionable review stage is shadow despite a pending snapshot', async () => {
  const boq = detailBoq({ activeExtractionRunId: 'run-1' })
  const liveFingerprint = fingerprintCanonicalSections(boq.sections)
  const harness = actionableApprovalHarness(
    boq,
    [makeActionableSnapshot('2026-01-01T00:00:00.000Z', liveFingerprint, [{ status: 'pending' }])],
    'shadow',
  )

  const response = await harness.handlers.PUT(approveRequest(), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.current().status, 'approved')
})

test('approval retries the transaction and blocks after a concurrent restore adds a pending suggestion', async () => {
  const boq = detailBoq({ activeExtractionRunId: 'run-1' })
  const liveFingerprint = fingerprintCanonicalSections(boq.sections)
  const resolved = makeActionableSnapshot('2026-01-01T00:00:00.000Z', liveFingerprint, [
    { status: 'added_matched' },
  ])
  const restored = makeActionableSnapshot('2026-01-02T00:00:00.000Z', liveFingerprint, [
    { status: 'pending' },
  ])
  let snapshots: TestActionableSnapshot[] = [resolved]
  let restoreFired = false
  let current = boq
  let attempts = 0
  const handlers = createBoqDetailHandlers({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => current,
    updateBoq: async (_id, prepareUpdate) => {
      attempts += 1
      let blocking = readActionableBlocking(current, snapshots)
      let decision = prepareUpdate(current, blocking)
      // First attempt read the resolved snapshot and would commit, but a
      // concurrent restore flips the latest snapshot to pending before the
      // commit. The transaction conflicts and retries, re-reading the
      // now-pending snapshot.
      if (attempts === 1 && decision.kind === 'update' && !restoreFired) {
        restoreFired = true
        snapshots = [restored]
        attempts += 1
        blocking = readActionableBlocking(current, snapshots)
        decision = prepareUpdate(current, blocking)
      }
      if (decision.kind === 'rejected') return decision
      current = { ...current, ...decision.updates } as Boq
      return 'updated'
    },
    deleteBoq: async () => {},
    loadSource: async () => Buffer.from('%PDF'),
    deleteSource: async () => {},
    saveSource: async () => {},
    logError: () => {},
  })

  const response = await handlers.PUT(approveRequest(), detailContext)
  const body = await response.json()

  assert.equal(attempts, 2)
  assert.equal(restoreFired, true)
  assert.equal(response.status, 400)
  assert.equal(body.error, 'Resolve pending extraction review before approval')
  assert.equal(body.actionableReview.pending, 1)
  assert.equal(body.actionableReview.stale, false)
  assert.equal(current.status, 'draft')
})
