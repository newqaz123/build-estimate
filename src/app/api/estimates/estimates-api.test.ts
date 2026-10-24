import assert from 'node:assert/strict'
import test from 'node:test'

import type { Estimate } from '@/lib/estimate-schema'
import { createEstimateCreateHandler, createEstimateUpdateHandler } from './handler'

function memoryStore(signedIn = true) {
  const docs = new Map<string, Estimate>()
  let nextId = 0
  const shared = {
    authenticate: async () => (signedIn ? { user: { id: '1' } } : null),
    logError: () => {},
  }
  const POST = createEstimateCreateHandler({
    ...shared,
    newId: () => `est-${++nextId}`,
    createEstimate: async (id, estimate) => {
      const doc = { ...estimate, createdAt: 't0', updatedAt: 't0' } as Estimate
      docs.set(id, doc)
      return doc
    },
  })
  const PUT = createEstimateUpdateHandler({
    ...shared,
    getEstimate: async (id) => docs.get(id) ?? null,
    updateEstimate: async (id, updates) => {
      const doc = { ...docs.get(id)!, ...updates, updatedAt: 't1' }
      docs.set(id, doc)
      return doc
    },
  })
  return { docs, POST, PUT }
}

function jsonRequest(method: 'POST' | 'PUT', path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const context = (id: string) => ({ params: Promise.resolve({ id }) })

function rebarLine(overrides: Record<string, unknown> = {}) {
  return { code: '', desc: 'Rebar SD40 16mm', unit: 'ton', qty: 10, rate: 100, total: 1, source: 'manual', ...overrides }
}

test('creating an estimate stores totals priced on the server, not the totals the browser sent', async () => {
  const store = memoryStore()
  const response = await store.POST(jsonRequest('POST', '/api/estimates', {
    name: 'Tower A',
    date: '2026-10-24',
    items: [rebarLine()],
  }))

  assert.equal(response.status, 201)
  const saved = store.docs.get('est-1')!
  assert.equal(saved.items[0].total, 1000)
  assert.equal(saved.totalAmount, 1000)
  assert.equal((await response.json()).totalAmount, 1000)
})

test('creating an estimate with an invalid line is refused and stores nothing', async () => {
  const store = memoryStore()
  const response = await store.POST(jsonRequest('POST', '/api/estimates', {
    name: 'Tower A',
    date: '2026-10-24',
    items: [rebarLine({ qty: -1 })],
  }))

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Line 1: quantity must be a number of zero or more.' })
  assert.equal(store.docs.size, 0)
})

test('saving an existing estimate updates the same record and re-prices its lines', async () => {
  const store = memoryStore()
  await store.POST(jsonRequest('POST', '/api/estimates', { name: 'Tower A', date: '2026-10-24', items: [rebarLine()] }))

  const response = await store.PUT(
    jsonRequest('PUT', '/api/estimates/est-1', { name: 'Tower A rev 2', items: [rebarLine({ qty: 3, rate: 50, total: 1 })] }),
    context('est-1'),
  )

  assert.equal(response.status, 200)
  assert.equal(store.docs.size, 1)
  const saved = store.docs.get('est-1')!
  assert.equal(saved.name, 'Tower A rev 2')
  assert.equal(saved.items[0].total, 150)
  assert.equal(saved.totalAmount, 150)
})

test('saving an estimate with an invalid line or an unknown status changes nothing', async () => {
  const store = memoryStore()
  await store.POST(jsonRequest('POST', '/api/estimates', { name: 'Tower A', date: '2026-10-24', items: [rebarLine()] }))
  const before = structuredClone(store.docs.get('est-1'))

  const badLine = await store.PUT(jsonRequest('PUT', '/api/estimates/est-1', { items: [rebarLine({ rate: 'cheap' })] }), context('est-1'))
  assert.equal(badLine.status, 400)
  assert.deepEqual(await badLine.json(), { error: 'Line 1: unit price must be a number of zero or more.' })

  const badStatus = await store.PUT(jsonRequest('PUT', '/api/estimates/est-1', { status: 'approved' }), context('est-1'))
  assert.equal(badStatus.status, 400)
  assert.deepEqual(await badStatus.json(), { error: 'Status must be draft or final.' })

  assert.deepEqual(store.docs.get('est-1'), before)
})

test('estimate writes require sign-in and an existing estimate', async () => {
  const signedOut = memoryStore(false)
  assert.equal((await signedOut.POST(jsonRequest('POST', '/api/estimates', { name: 'A', date: '' }))).status, 401)
  assert.equal((await signedOut.PUT(jsonRequest('PUT', '/api/estimates/x', { name: 'A' }), context('x'))).status, 401)

  const store = memoryStore()
  assert.equal((await store.PUT(jsonRequest('PUT', '/api/estimates/missing', { name: 'A' }), context('missing'))).status, 404)
})
