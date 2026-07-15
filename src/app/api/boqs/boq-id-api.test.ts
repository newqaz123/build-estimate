import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqItem } from '@/lib/boq-schema'
import { createBoqDetailHandlers } from './[id]/route'
import { createSourceHandler } from './[id]/source/route'

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
    updateBoq: async (_id, update) => {
      updates.push(update)
      current = current ? { ...current, ...update } as Boq : null
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

test('approval builds and verifies the candidate while recomputing section totals', async () => {
  const harness = detailHarness()
  const sections = [{ header: 'Concrete', items: [item()] }]
  const response = await harness.handlers.PUT(new Request('http://localhost/api/boqs/boq-1', {
    method: 'PUT',
    body: JSON.stringify({ status: 'approved', sections, grandTotal: 999_999 }),
  }), detailContext)

  assert.equal(response.status, 200)
  assert.equal(harness.updates[0]?.grandTotal, 200)
  assert.equal('sourceStoragePath' in (await response.json()), false)
})

test('approval rejects every blocking local verification category with structured details', async (t) => {
  const cases: [string, Partial<Boq>, Record<string, unknown>][] = [
    ['unclassified', {}, { status: 'approved', workType: 'Unclassified' }],
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
      assert.equal(body.error, 'Resolve required BOQ fields before approval')
      assert.equal(body.verification.hasBlockingIssues, true)
      assert.equal(harness.updates.length, 0)
    })
  }
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
