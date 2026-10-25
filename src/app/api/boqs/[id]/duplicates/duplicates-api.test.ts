import assert from 'node:assert/strict'
import test from 'node:test'

import { createDuplicatesGetHandler } from './handler'

const ctx = { params: Promise.resolve({ id: 'q1' }) }
const req = new Request('http://x/api/boqs/q1/duplicates')

test('duplicates endpoint needs a session, 404s unknown quotes and lists matches', async () => {
  const match = { id: 'q0', project: 'P', vendor: 'V', date: '2026-10-01', status: 'approved' as const, grandTotal: 1, reason: 'same_quote' as const }
  assert.equal((await createDuplicatesGetHandler({ authenticate: async () => null, findDuplicates: async () => [] })(req, ctx)).status, 401)
  assert.equal((await createDuplicatesGetHandler({ authenticate: async () => ({ user: {} }), findDuplicates: async () => null })(req, ctx)).status, 404)
  const ok = await createDuplicatesGetHandler({ authenticate: async () => ({ user: {} }), findDuplicates: async (id) => (id === 'q1' ? [match] : []) })(req, ctx)
  assert.deepEqual(await ok.json(), { duplicates: [match] })
})
