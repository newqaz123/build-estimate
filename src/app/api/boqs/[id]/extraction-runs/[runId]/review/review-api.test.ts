import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq } from '@/lib/boq-schema'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import { buildDurableExtractionReviewResponse, createExtractionReviewHandler, type ExtractionReviewHandlerDependencies } from './review-api'

const boq = { id: 'boq-1', sections: [] } as unknown as Boq
const run = { id: 'run-1', boqId: 'boq-1', status: 'ready' } as BoqExtractionRun
const rows: BoqSourceRowV3[] = [{
  id: 'row-1', page: 2, table: 1, row: 3, section: 'Drainage', headers: ['Description'], rawText: 'Gutter',
  rawCells: [{ column: 0, rawText: 'Gutter', lines: ['Gutter'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 0, endColumnOffset: 1, columnHeader: false, rowHeader: false, rowSection: false, carried: false }],
  classification: 'item', confidence: 0.92, warnings: [],
}]

function handler(overrides: Partial<ExtractionReviewHandlerDependencies> = {}) {
  return createExtractionReviewHandler({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    getReadyImport: async () => ({ boq, run }),
    getSourceRows: async () => rows,
    getReviewState: async () => ({ proposals: [], proposalStatuses: {}, auditEvents: [], reviewRun: { status: 'queued' } }),
    acquireReviewLease: async () => ({ kind: 'acquired', reviewRun: { status: 'running', leaseId: 'lease-1' } }),
    completeReviewLease: async (_boqId, _runId, _leaseId, status) => ({ status }),
    failReviewLease: async (_boqId, _runId, _leaseId, failureCode) => ({ status: 'failed', failureCode }),
    createLeaseId: () => 'lease-1',
    getSettings: async () => null,
    callProvider: async () => ({ content: '{"proposals":[]}', provider: 'openai', model: 'gpt-4o' }),
    env: {}, timeoutMs: 10,
    ...overrides,
  })
}

test('review endpoint requires authentication before it reads extraction evidence', async () => {
  let reads = 0
  const response = await handler({
    authenticate: async () => null,
    getReadyImport: async () => { reads += 1; return { boq, run } },
  })(new Request('https://example.test/api/boqs/boq-1/extraction-runs/run-1/review', { method: 'POST', body: '{}' }), {
    params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }),
  })
  assert.equal(response.status, 401)
  assert.equal(reads, 0)
})

test('review endpoint validates JSON before it calls the provider', async () => {
  let providerCalls = 0
  const response = await handler({
    callProvider: async () => { providerCalls += 1; throw new Error('must not call') },
  })(new Request('https://example.test/api/boqs/boq-1/extraction-runs/run-1/review', {
    method: 'POST', body: JSON.stringify({ unexpected: true }), headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) })
  assert.equal(response.status, 400)
  assert.equal(providerCalls, 0)
})

test('an explicit forced recheck is forwarded to the completed-request lease guard', async () => {
  let forced = false
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1'], candidateCount: 1, unreconciled: false },
    reconciliation: { itemTotal: 0, sourceTotal: 0, reconciled: true, difference: 0 }, sections: [],
  }
  const response = await handler({
    getReadyImport: async () => ({ boq, run: selectedRun }),
    acquireReviewLease: async (_boqId, _runId, _requestKey, _leaseId, _ttl, force) => {
      forced = force
      return { kind: 'acquired', reviewRun: { status: 'running', leaseId: 'lease-1' } }
    },
  })(new Request('https://example.test', {
    method: 'POST', body: JSON.stringify({ manual: false, force: true }), headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) })

  assert.equal(response.status, 200)
  assert.equal(forced, true)
})

test('review endpoint returns selected immutable source-row display evidence', async () => {
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1'], candidateCount: 1, unreconciled: false },
    reconciliation: { itemTotal: 0, sourceTotal: 0, reconciled: true, difference: 0 },
    sections: [],
  }
  const response = await handler({
    getReadyImport: async () => ({ boq, run: selectedRun }),
    env: {},
  })(new Request('https://example.test/api/boqs/boq-1/extraction-runs/run-1/review', {
    method: 'POST', body: JSON.stringify({ manual: false }), headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) })

  assert.equal(response.status, 200)
  const body = await response.json() as { sourceRows: Array<{ sourceRowId: string; rawText: string; page: number }> }
  assert.deepEqual(body.sourceRows.map(({ sourceRowId, rawText, page }) => ({ sourceRowId, rawText, page })), [
    { sourceRowId: 'row-1', rawText: 'Gutter', page: 2 },
  ])
})

test('review reload returns durable proposals and reconstructed action statuses', async () => {
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1'], candidateCount: 1, unreconciled: false },
    reconciliation: { itemTotal: 0, sourceTotal: 0, reconciled: true, difference: 0 },
    sections: [],
  }
  const stored = { id: 'stored-1', evidenceValid: true, reconciled: true, stale: false }
  const response = await handler({
    getReadyImport: async () => ({ boq, run: selectedRun }),
    getReviewState: async () => ({
      proposals: [stored as never],
      proposalStatuses: { 'stored-1': { status: 'accepted', canUndo: true } },
      auditEvents: [{ proposalId: 'stored-1', status: 'accepted' } as never],
      reviewRun: { status: 'completed' },
    }),
  })(new Request('https://example.test', {
    method: 'POST', body: JSON.stringify({ manual: false }), headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) })
  const body = await response.json() as { proposals: Array<{ id: string }>; proposalStatuses: Record<string, { status: string }>; auditEvents: unknown[] }
  assert.deepEqual(body.proposals.map((proposal) => proposal.id), ['stored-1'])
  assert.equal(body.proposalStatuses['stored-1'].status, 'accepted')
  assert.equal(body.auditEvents.length, 1)
})

test('concurrent automatic dispatch makes one provider call while the second request observes the lease', async () => {
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1'], candidateCount: 1, unreconciled: false },
    reconciliation: { itemTotal: 0, sourceTotal: 0, reconciled: true, difference: 0 }, sections: [],
  }
  let leased = false
  let providerCalls = 0
  const review = handler({
    getReadyImport: async () => ({ boq, run: selectedRun }),
    acquireReviewLease: async () => leased
      ? { kind: 'busy', reviewRun: { status: 'running', leaseId: 'lease-1' } }
      : (leased = true, { kind: 'acquired', reviewRun: { status: 'running', leaseId: 'lease-1' } }),
    getSettings: async () => ({ llm: { provider: 'openai', model: 'gpt-4o-mini' } } as never),
    env: { OPENAI_API_KEY: 'test-key' },
    callProvider: async () => { providerCalls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { content: '{"proposals":[]}', provider: 'openai', model: 'gpt-4o-mini' } },
  })
  const makeRequest = () => new Request('https://example.test', { method: 'POST', body: JSON.stringify({ manual: false }) })
  await Promise.all([
    review(makeRequest(), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) }),
    review(makeRequest(), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) }),
  ])
  assert.equal(providerCalls, 1)
})

test('a durable failed lease prevents an immediate automatic provider retry', async () => {
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1'], candidateCount: 1, unreconciled: false },
    reconciliation: { itemTotal: 0, sourceTotal: 0, reconciled: true, difference: 0 }, sections: [],
  }
  let failed = false
  let providerCalls = 0
  const review = handler({
    getReadyImport: async () => ({ boq, run: selectedRun }),
    acquireReviewLease: async () => failed
      ? { kind: 'failed', reviewRun: { status: 'failed', failureCode: 'timeout', retryAfter: '2099-01-01T00:00:00.000Z' } }
      : { kind: 'acquired', reviewRun: { status: 'running', leaseId: 'lease-1' } },
    failReviewLease: async () => { failed = true; return { status: 'failed', failureCode: 'timeout' } },
    getSettings: async () => ({ llm: { provider: 'openai', model: 'gpt-4o-mini' } } as never),
    env: { OPENAI_API_KEY: 'test-key' },
    callProvider: async () => { providerCalls += 1; throw new Error('timeout') },
  })
  const makeRequest = () => new Request('https://example.test', { method: 'POST', body: JSON.stringify({ manual: false }) })
  await review(makeRequest(), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) })
  await review(makeRequest(), { params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }) })
  assert.equal(providerCalls, 1)
})

test('durable GET/POST snapshots replace client state and include every candidate row once', () => {
  const row2 = { ...rows[0]!, id: 'row-2', row: 4, rawText: 'Second candidate' }
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1', 'row-2'], candidateCount: 2, unreconciled: true },
    reconciliation: { itemTotal: 0, sourceTotal: 10, reconciled: false, difference: -10 }, sections: [],
  }
  const response = buildDurableExtractionReviewResponse({
    imported: { boq, run: selectedRun }, sourceRows: [...rows, row2],
    stored: {
      proposals: [], proposalStatuses: {}, auditEvents: [],
      reviewRun: { status: 'running', reviewTargeting: { candidateRowIds: ['row-1', 'row-2'], unreconciled: true } },
    },
  })
  assert.equal(response.snapshotMode, 'replace')
  assert.deepEqual(response.sourceRowIds, ['row-1', 'row-2'])
  assert.deepEqual(response.reviewRun.reviewTargeting, {
    candidateRowIds: ['row-1', 'row-2'], ambiguousRowIds: [], unreconciledRowIds: [], unreconciled: true,
  })
})

test('durable snapshots remove successfully reviewed no-proposal rows from follow-up', () => {
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1'], candidateCount: 1, unreconciled: false },
    reconciliation: { itemTotal: 0, sourceTotal: 0, reconciled: true, difference: 0 }, sections: [],
  }
  const response = buildDurableExtractionReviewResponse({
    imported: { boq, run: selectedRun }, sourceRows: rows,
    stored: {
      proposals: [], proposalStatuses: {}, auditEvents: [],
      reviewRun: { status: 'completed', reviewedSourceRowIds: ['row-1'] },
    },
  })

  assert.deepEqual(response.remainingCandidateRowIds, [])
})

test('durable snapshot preserves reason-specific source-row targeting', () => {
  const compound = { ...rows[0]!, id: 'row-compound', rawText: 'Aligned compound row' }
  const ambiguous = { ...rows[0]!, id: 'row-ambiguous', row: 4, confidence: 0.7, rawText: 'Ambiguous row' }
  const reconciled = { ...rows[0]!, id: 'row-unreconciled', row: 5, rawText: 'Section mismatch' }
  const unrelated = { ...rows[0]!, id: 'row-unrelated', row: 6, rawText: 'Reliable item' }
  const selectedRun = {
    ...run,
    reviewTargeting: {
      candidateRowIds: ['row-compound', 'row-ambiguous', 'row-unreconciled'], candidateCount: 3,
      ambiguousRowIds: ['row-ambiguous'], unreconciledRowIds: ['row-unreconciled'], unreconciled: true,
    },
    reconciliation: { itemTotal: 9, sourceTotal: 10, reconciled: false, difference: -1 }, sections: [],
  }
  const response = buildDurableExtractionReviewResponse({
    imported: { boq, run: selectedRun }, sourceRows: [compound, ambiguous, reconciled, unrelated],
    stored: { proposals: [], proposalStatuses: {}, auditEvents: [], reviewRun: { status: 'queued' } },
  })

  assert.deepEqual(response.reviewRun.reviewTargeting, {
    candidateRowIds: ['row-ambiguous', 'row-compound', 'row-unreconciled'],
    ambiguousRowIds: ['row-ambiguous'], unreconciledRowIds: ['row-unreconciled'], unreconciled: true,
  })
  assert.deepEqual(response.sourceRowIds, ['row-compound', 'row-ambiguous', 'row-unreconciled'])
})

test('a completed review atomically refreshes every reviewed source row even when no proposal is returned', async () => {
  const selectedRun = {
    ...run,
    reviewTargeting: { candidateRowIds: ['row-1'], candidateCount: 1, unreconciled: false },
    reconciliation: { itemTotal: 0, sourceTotal: 0, reconciled: true, difference: 0 }, sections: [],
  }
  let refreshedRows: readonly string[] = []
  const response = await handler({
    getReadyImport: async () => ({ boq, run: selectedRun }),
    getSettings: async () => ({ llm: { provider: 'openai', model: 'gpt-4o-mini' } } as never),
    env: { OPENAI_API_KEY: 'test-key' },
    completeReviewLease: async (_boqId, _runId, _leaseId, status, _proposals, sourceRowIds) => {
      refreshedRows = sourceRowIds
      return { status }
    },
  })(new Request('https://example.test', { method: 'POST', body: JSON.stringify({ manual: false }) }), {
    params: Promise.resolve({ id: 'boq-1', runId: 'run-1' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(refreshedRows, ['row-1'])
})
