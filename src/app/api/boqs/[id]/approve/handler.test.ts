import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq, BoqPricedItem } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { createApprovalHandlers, type ApprovalDependencies } from './handler'

const NOW = '2026-10-25T12:00:00.000Z'

function makeStore() {
  const store: { boq: Boq | null; standards: StandardEntry[]; writes: number } = {
    boq: {
      id: 'q1', project: 'P', vendor: 'V', workType: 'MEP', date: '2026-10-01', totalItems: 1, grandTotal: 50,
      status: 'draft', stdStatus: 'none', createdAt: NOW, updatedAt: NOW,
      sections: [{ header: 'S', items: [{ id: 'a', desc: 'Pipe', unit: 'm', qty: 5, rate: 10, total: 50, type: 'unit', stdStatus: 'unmatched' }] }],
    },
    standards: [{ id: 's1', description: 'Pipe', unit: 'm', aliases: [], sourceItems: [], sourceBoqCount: 0, createdAt: NOW, updatedAt: NOW }],
    writes: 0,
  }
  const deps: ApprovalDependencies = {
    authenticate: async () => ({ user: { id: 'u' } }),
    now: () => NOW,
    transact: async (_id, plan) => {
      if (!store.boq) return null
      const result = plan({ boq: store.boq, standards: store.standards, unitMap: {} })
      if ('rejected' in result) return result
      store.writes += 1
      store.boq = result.boq
      store.standards = store.standards.map((s) => result.standards.find((n) => n.id === s.id) ?? s)
      return result
    },
  }
  return { store, handlers: createApprovalHandlers(deps) }
}

const ctx = { params: Promise.resolve({ id: 'q1' }) }
const post = (body: unknown) => new Request('http://x/api/boqs/q1/approve', { method: 'POST', body: JSON.stringify(body) })

test('approve saves edits and choices in one write and returns the approved quote', async () => {
  const { store, handlers } = makeStore()
  const sections = structuredClone(store.boq!.sections)
  ;(sections[0]!.items[0] as BoqPricedItem).qty = 6
  ;(sections[0]!.items[0] as BoqPricedItem).total = 60
  const res = await handlers.approve(post({ vendor: 'Vendor B', sections, choices: [{ sectionIndex: 0, itemIndex: 0, itemId: 'a', standardId: 's1', confidence: 'exact' }] }), ctx)
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.boq.status, 'approved')
  assert.equal(json.linked, 1)
  assert.equal(store.writes, 1)
  assert.equal(store.boq!.vendor, 'Vendor B')
  assert.equal(store.boq!.grandTotal, 60)
  assert.equal(store.standards[0]!.sourceItems!.length, 1)
})

test('approve refuses broken data without writing, and approved quotes need Reopen', async () => {
  const { store, handlers } = makeStore()
  const bad = await handlers.approve(post({ vendor: '' }), ctx)
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).blocking[0].message, /vendor/)
  assert.equal(store.writes, 0)

  assert.equal((await handlers.approve(post({}), ctx)).status, 200)
  assert.equal((await handlers.approve(post({}), ctx)).status, 409)

  const reopened = await handlers.reopen(new Request('http://x', { method: 'POST' }), ctx)
  assert.equal(reopened.status, 200)
  assert.equal(store.boq!.status, 'review')
  assert.equal(store.boq!.approvedAt, undefined)
  assert.equal((await handlers.reopen(new Request('http://x', { method: 'POST' }), ctx)).status, 409)
})

test('approve validates input and auth', async () => {
  const { handlers } = makeStore()
  assert.equal((await handlers.approve(post({ choices: 'x' }), ctx)).status, 400)
  assert.equal((await handlers.approve(post({ choices: [{ sectionIndex: 0, itemIndex: 0, standardId: 5 }] }), ctx)).status, 400)
  assert.equal((await handlers.approve(post({ workType: 'Roofing' }), ctx)).status, 400)
  const anon = createApprovalHandlers({ authenticate: async () => null, now: () => NOW, transact: async () => null })
  assert.equal((await anon.approve(post({}), ctx)).status, 401)
  const missing = createApprovalHandlers({ authenticate: async () => ({ user: {} }), now: () => NOW, transact: async () => null })
  assert.equal((await missing.approve(post({}), ctx)).status, 404)
})
