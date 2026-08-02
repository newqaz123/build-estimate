import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { createStandardsMatchPostHandler } from './route'

function approvedBoq(): Boq {
  return {
    id: 'boq-approved',
    project: 'Approved project',
    vendor: 'Approved vendor',
    workType: 'Structural',
    date: '2026-08-02',
    totalItems: 1,
    grandTotal: 100,
    status: 'approved',
    stdStatus: 'none',
    sections: [{
      header: 'Concrete',
      items: [{
        id: 'item-1',
        code: 'A-1',
        desc: 'Source concrete',
        unit: 'm3',
        qty: 1,
        rate: 100,
        total: 100,
        type: 'unit',
        stdStatus: 'unmatched',
      }],
    }],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function standard(): StandardEntry {
  return {
    id: 'std-1',
    description: 'Ready-mix concrete',
    unit: 'm³',
    aliases: [],
    sourceItems: [],
    sourceBoqCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

test('approved BOQs return 409 from the match request without changing the BOQ or standard', async () => {
  const boqs = new Map<string, Boq>([['boq-approved', approvedBoq()]])
  const standards = new Map<string, StandardEntry>([['std-1', standard()]])
  const beforeBoq = structuredClone(boqs.get('boq-approved'))
  const beforeStandard = structuredClone(standards.get('std-1'))
  let writes = 0

  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return { collection: name, id }
        },
      }
    },
  } as unknown as FirebaseFirestore.Firestore
  const transaction = {
    async get(ref: { collection: string; id: string }) {
      const value = ref.collection === 'boqs' ? boqs.get(ref.id) : standards.get(ref.id)
      return {
        exists: value !== undefined,
        id: ref.id,
        data: () => value ? structuredClone(value) : undefined,
      }
    },
    update() { writes += 1 },
    set() { writes += 1 },
  } as unknown as FirebaseFirestore.Transaction

  const post = createStandardsMatchPostHandler({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    runTransaction: async (work) => work(transaction, db),
  })
  const response = await post(new Request('https://example.test/api/standards/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      boqId: 'boq-approved',
      sectionIndex: 0,
      itemId: 'item-1',
      standardId: 'std-1',
      confidence: 'manual',
    }),
  }))

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'Approved BOQs cannot be edited.' })
  assert.equal(writes, 0)
  assert.deepEqual(boqs.get('boq-approved'), beforeBoq)
  assert.deepEqual(standards.get('std-1'), beforeStandard)
})
