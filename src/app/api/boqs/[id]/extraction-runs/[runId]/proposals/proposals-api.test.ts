import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractionProposal } from '@/lib/boq-extraction-proposals'
import type { SourceBackedManualAddRequest } from '@/lib/boq-user-entry'
import { createExtractionProposalActionHandlers, type ExtractionProposalActionDependencies } from './proposals-api'

const proposal = { id: 'proposal-1' } as ExtractionProposal
const context = { params: Promise.resolve({ id: 'boq-1', runId: 'run-1', proposalId: 'proposal-1' }) }
function request(body: unknown = { proposal }) { return new Request('https://example.test', { method: 'POST', body: JSON.stringify(body) }) }

function handlers(overrides: Partial<ExtractionProposalActionDependencies> = {}) {
  return createExtractionProposalActionHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    accept: async () => ({ status: 200, body: { status: 'accepted' } }),
    acceptBatch: async () => ({ status: 200, body: { status: 'accepted', acceptedProposalIds: [] } }),
    reject: async () => ({ status: 200, body: { status: 'rejected' } }),
    skip: async () => ({ status: 200, body: { status: 'skipped' } }),
    reopen: async () => ({ status: 200, body: { status: 'pending' } }),
    undo: async () => ({ status: 200, body: { status: 'undone' } }),
    addSourceItem: async () => ({ status: 200, body: { status: 'accepted' } }),
    ...overrides,
  })
}

test('proposal actions authenticate before any transaction work', async () => {
  let calls = 0
  const response = await handlers({ authenticate: async () => null, accept: async () => { calls += 1; return { status: 500, body: { error: 'no' } } } }).accept(request(), context)
  assert.equal(response.status, 401)
  assert.equal(calls, 0)
})

test('accept uses only the opaque proposal path id and tolerates the legacy echoed body', async () => {
  let calls = 0
  const action = handlers({ accept: async () => { calls += 1; return { status: 200, body: {} } } })
  assert.equal((await action.accept(request({}), context)).status, 200)
  assert.equal((await action.accept(request({ proposal: { id: 'other', total: 999_999 } }), context)).status, 200)
  assert.equal(calls, 2)
})

test('accept, reject, and undo dispatch only opaque path identifiers to server actions', async () => {
  const calls: string[] = []
  const action = handlers({
    accept: async (boqId, runId, proposalId) => { calls.push(`accept:${boqId}:${runId}:${proposalId}`); return { status: 200, body: {} } },
    reject: async (boqId, runId, proposalId) => { calls.push(`reject:${boqId}:${runId}:${proposalId}`); return { status: 200, body: {} } },
    undo: async (boqId, runId, proposalId) => { calls.push(`undo:${boqId}:${runId}:${proposalId}`); return { status: 200, body: {} } },
  })
  await action.accept(request(), context)
  await action.reject(request(), context)
  await action.undo(new Request('https://example.test', { method: 'POST' }), context)
  assert.deepEqual(calls, ['accept:boq-1:run-1:proposal-1', 'reject:boq-1:run-1:proposal-1', 'undo:boq-1:run-1:proposal-1'])
})

test('skip and reopen dispatch opaque path identifiers and actor identity', async () => {
  const calls: string[] = []
  const action = handlers({
    skip: async (boqId, runId, proposalId, actorId) => { calls.push(`skip:${boqId}:${runId}:${proposalId}:${actorId}`); return { status: 200, body: { status: 'skipped' } } },
    reopen: async (boqId, runId, proposalId, actorId) => { calls.push(`reopen:${boqId}:${runId}:${proposalId}:${actorId}`); return { status: 200, body: { status: 'pending' } } },
  })
  await action.skip(request(), context)
  await action.reopen(request(), context)
  assert.deepEqual(calls, ['skip:boq-1:run-1:proposal-1:user-1', 'reopen:boq-1:run-1:proposal-1:user-1'])
})

test('batch acceptance authenticates and forwards only unique bounded opaque ids', async () => {
  const calls: unknown[] = []
  const action = handlers({
    acceptBatch: async (boqId, runId, proposalIds, actorId) => {
      calls.push({ boqId, runId, proposalIds, actorId })
      return { status: 200, body: { acceptedProposalIds: proposalIds } }
    },
  })
  const batchContext = { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) }
  const response = await action.acceptBatch(new Request('https://example.test', {
    method: 'POST', body: JSON.stringify({ proposalIds: ['proposal-1', 'proposal-2'] }),
  }), batchContext)
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [{ boqId: 'boq-1', runId: 'run-1', proposalIds: ['proposal-1', 'proposal-2'], actorId: 'user-1' }])
  assert.equal((await action.acceptBatch(new Request('https://example.test', {
    method: 'POST', body: JSON.stringify({ proposalIds: ['proposal-1', 'proposal-1'] }),
  }), batchContext)).status, 400)
})

const sourceItemBody = {
  sectionIndex: 0,
  item: { desc: 'Wall installation', unit: 'm2', qty: 18, materialCost: 980, labourCost: 650 },
}

test('addSourceItem authenticates before body parsing and forwards opaque path ids', async () => {
  const calls: Array<{ boqId: string; runId: string; proposalId: string; request: SourceBackedManualAddRequest; actorId: string }> = []
  let authCalls = 0
  const action = handlers({
    authenticate: async () => { authCalls += 1; return { user: { id: 'user-1' } } },
    addSourceItem: async (boqId, runId, proposalId, requestBody, actorId) => {
      calls.push({ boqId, runId, proposalId, request: requestBody, actorId })
      return { status: 200, body: { status: 'accepted' } }
    },
  })
  const response = await action.addSourceItem(request(sourceItemBody), context)
  assert.equal(response.status, 200)
  assert.equal(authCalls, 1)
  assert.deepEqual(calls, [{
    boqId: 'boq-1', runId: 'run-1', proposalId: 'proposal-1', actorId: 'user-1',
    request: {
      mode: 'single',
      value: { sectionIndex: 0, desc: 'Wall installation', unit: 'm2', qty: 18, materialCost: 980, labourCost: 650 },
    },
  }])

  const unauthenticated = await handlers({
    authenticate: async () => null,
    addSourceItem: async () => { throw new Error('must not be called when unauthenticated') },
  }).addSourceItem(request(sourceItemBody), context)
  assert.equal(unauthenticated.status, 401)
})

test('addSourceItem rejects malformed bodies and invalid path ids before delegating', async () => {
  const action = handlers({
    addSourceItem: async () => { throw new Error('dependency must not be called for malformed input') },
  })
  assert.equal((await action.addSourceItem(request({ sectionIndex: 0, item: { desc: '', unit: 'm2', qty: 1, materialCost: 0, labourCost: 0 } }), context)).status, 400)
  assert.equal((await action.addSourceItem(request({ sectionIndex: 0 }), context)).status, 400)
  assert.equal((await action.addSourceItem(new Request('https://example.test', { method: 'POST', body: 'not-json' }), context)).status, 400)

  const badPath = { params: Promise.resolve({ id: 'boq-1', runId: 'run-1', proposalId: 'has/slash' }) }
  assert.equal((await action.addSourceItem(request(sourceItemBody), badPath)).status, 400)
})

const decisionBatchSourceItemBody = {
  decisions: [
    { sourceRowId: 'row-1', action: 'add', sectionIndex: 0, item: { desc: 'Tooling', unit: 'Lot', qty: 1, materialCost: 6000, labourCost: 0 } },
    { sourceRowId: 'row-2', action: 'ignore', note: 'Summary' },
  ],
}

test('addSourceItem forwards a parsed decision-batch request to the dependency unchanged', async () => {
  const calls: Array<{ boqId: string; runId: string; proposalId: string; request: SourceBackedManualAddRequest; actorId: string }> = []
  const action = handlers({
    addSourceItem: async (boqId, runId, proposalId, requestBody, actorId) => {
      calls.push({ boqId, runId, proposalId, request: requestBody, actorId })
      return { status: 200, body: { status: 'accepted' } }
    },
  })
  const response = await action.addSourceItem(request(decisionBatchSourceItemBody), context)
  assert.equal(response.status, 200)
  if (response.status !== 200) return
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.request.mode, 'decision_batch')
  if (calls[0]!.request.mode !== 'decision_batch') return
  assert.equal(calls[0]!.request.decisions.length, 2)
  assert.equal(calls[0]!.request.decisions[0]!.action, 'add')
  assert.equal(calls[0]!.request.decisions[1]!.action, 'ignore')
})

test('addSourceItem rejects malformed or duplicate decision bodies without calling the dependency', async () => {
  const action = handlers({
    addSourceItem: async () => { throw new Error('dependency must not be called for malformed input') },
  })
  assert.equal((await action.addSourceItem(request({ decisions: [] }), context)).status, 400)
  assert.equal((await action.addSourceItem(request({ decisions: [
    { sourceRowId: 'row-1', action: 'add', sectionIndex: 0, item: { desc: 'A', unit: 'Lot', qty: 1, materialCost: 1, labourCost: 0 } },
    { sourceRowId: 'row-1', action: 'ignore' },
  ] }), context)).status, 400)
  assert.equal((await action.addSourceItem(request({ decisions: [
    { sourceRowId: 'row-1', action: 'add', sectionIndex: 0, item: { desc: '', unit: 'Lot', qty: 1, materialCost: 1, labourCost: 0 } },
  ] }), context)).status, 400)
  // Obsolete { items } shape falls into the single parser and fails.
  assert.equal((await action.addSourceItem(request({ items: [{ sourceRowId: 'row-1', sectionIndex: 0, item: { desc: 'A', unit: 'Lot', qty: 1, materialCost: 1, labourCost: 0 } }] }), context)).status, 400)
})
