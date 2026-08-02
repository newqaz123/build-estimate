import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { createComparisonGetHandler } from './handler'

const now = '2026-08-02T00:00:00.000Z'

const standard: StandardEntry = {
  id: 'std-valve',
  description: 'STUB-END 6B BS4',
  unit: 'Lot',
  aliases: [],
  sourceBoqCount: 1,
  createdAt: now,
  updatedAt: now,
}

function boq(id: string, materialRate: number): Boq {
  return {
    id,
    project: 'Valve installation',
    vendor: 'E.T.G.',
    workType: 'MEP',
    date: '2026-06-04',
    totalItems: 1,
    grandTotal: 36864,
    status: 'approved',
    stdStatus: 'complete',
    sections: [{
      header: 'E&M',
      items: [{
        id: `${id}-item`,
        desc: 'STUB-END 6B BS4',
        unit: 'Lot',
        qty: 1,
        rate: 36864,
        total: 36864,
        type: 'unit',
        stdStatus: 'matched',
        stdId: 'std-valve',
        sourceCosts: {
          material: {
            present: true,
            qty: 8,
            unit: 'Pcs',
            rate: materialRate,
            total: materialRate * 8,
          },
          labour: {
            present: true,
            qty: 48,
            unit: 'Db',
            rate: 300,
            total: 14400,
          },
        },
      }],
    }],
    createdAt: now,
    updatedAt: now,
  }
}

const context = {
  params: Promise.resolve({ id: 'target' }),
}

test('comparison API requires authentication before loading data', async () => {
  let loaded = false
  const GET = createComparisonGetHandler({
    authenticate: async () => null,
    loadBoqs: async () => {
      loaded = true
      return []
    },
    loadStandards: async () => [],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )

  assert.equal(response.status, 401)
  assert.equal(loaded, false)
})

test('comparison API returns component comparison records', async () => {
  const GET = createComparisonGetHandler({
    authenticate: async () => ({ user: {} }),
    loadBoqs: async () => [boq('target', 2808), boq('prior', 2750)],
    loadStandards: async () => [standard],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.boqId, 'target')
  assert.equal(body.rows[0].components.material.unit, 'Pcs')
  assert.equal(body.rows[0].components.material.benchmark.average, 2750)
  assert.equal(body.rows[0].components.labour.unit, 'Db')
})

test('comparison API returns 404 for a missing BOQ', async () => {
  const GET = createComparisonGetHandler({
    authenticate: async () => ({ user: {} }),
    loadBoqs: async () => [],
    loadStandards: async () => [standard],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'BOQ not found' })
})

test('comparison API returns a non-leaking 500', async (t) => {
  t.mock.method(console, 'error', () => {})

  const GET = createComparisonGetHandler({
    authenticate: async () => ({ user: {} }),
    loadBoqs: async () => {
      throw new Error('FIREBASE_PROJECT_ID=production-secret')
    },
    loadStandards: async () => [],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )
  const body = await response.json()

  assert.equal(response.status, 500)
  assert.deepEqual(body, { error: 'Internal server error' })
  assert.doesNotMatch(JSON.stringify(body), /FIREBASE|production-secret/)
})
