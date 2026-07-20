import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractionProposal } from '@/lib/boq-extraction-proposals'
import { createExtractionProposalActionHandlers, type ExtractionProposalActionDependencies } from './proposals-api'

const proposal = { id: 'proposal-1' } as ExtractionProposal
const context = { params: Promise.resolve({ id: 'boq-1', runId: 'run-1', proposalId: 'proposal-1' }) }
function request(body: unknown = { proposal }) { return new Request('https://example.test', { method: 'POST', body: JSON.stringify(body) }) }

function handlers(overrides: Partial<ExtractionProposalActionDependencies> = {}) {
  return createExtractionProposalActionHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    accept: async () => ({ status: 200, body: { status: 'accepted' } }),
    reject: async () => ({ status: 200, body: { status: 'rejected' } }),
    undo: async () => ({ status: 200, body: { status: 'undone' } }),
    ...overrides,
  })
}

test('proposal actions authenticate before any transaction work', async () => {
  let calls = 0
  const response = await handlers({ authenticate: async () => null, accept: async () => { calls += 1; return { status: 500, body: { error: 'no' } } } }).accept(request(), context)
  assert.equal(response.status, 401)
  assert.equal(calls, 0)
})

test('accept rejects malformed and mismatched proposal bodies before mutation', async () => {
  let calls = 0
  const action = handlers({ accept: async () => { calls += 1; return { status: 200, body: {} } } })
  assert.equal((await action.accept(request({}), context)).status, 400)
  assert.equal((await action.accept(request({ proposal: { id: 'other' } }), context)).status, 400)
  assert.equal(calls, 0)
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
