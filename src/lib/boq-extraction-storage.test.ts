import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq } from './boq-schema'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import type { BoqExtractionRun } from './boq-extraction-run'
import {
  ExtractionCleanupUncertainError,
  cleanupExpiredStagingRuns,
  extractionRunPath,
  persistStagedRun,
  sourceRowPath,
  type ExtractionStore,
} from './boq-extraction-storage'

test('logical paths use nested BOQ extraction subcollections', () => {
  assert.equal(extractionRunPath('boq-1', 'run-1'), 'boqs/boq-1/extractionRuns/run-1')
  assert.equal(sourceRowPath('boq-1', 'run-1', 'row-1'), 'boqs/boq-1/extractionRuns/run-1/sourceRows/row-1')
})

function fixture(count = 3) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`, page: 1, table: 1, row: index + 1, section: null,
    headers: [], rawCells: [], rawText: `row ${index}`, classification: 'item',
    confidence: 1, warnings: [],
  })) as BoqSourceRowV3[]
  const run = {
    id: 'run-1', boqId: 'boq-1', contractVersion: 3, status: 'staging',
    createdAt: '2026-07-19T00:00:00Z', updatedAt: '2026-07-19T00:00:00Z',
    stagingExpiresAt: '2026-07-20T00:00:00Z', sourceFile: { path: 'source.pdf', name: 'source.pdf', digest: 'digest' },
    parser: { name: 'docling', contractVersion: 3, configFingerprint: 'config' },
    metadataCandidates: {}, metadataConfidence: {}, sourceRowCount: count,
    sourceRowChecksum: 'checksum', reconciliation: { itemTotal: 0, sourceTotal: null, reconciled: true, difference: 0 },
    warnings: [], sections: [], totalItems: 0, aiReviewStatus: 'not_required',
    reviewTargeting: { candidateRowIds: [], candidateCount: 0, unreconciled: false },
  } as unknown as BoqExtractionRun
  const boq = { id: 'boq-1', sections: [] } as unknown as Omit<Boq, 'createdAt' | 'updatedAt'>
  return { rows, run, boq }
}

function storeHarness(overrides: Partial<ExtractionStore> = {}) {
  const events: string[] = []
  const batches: number[] = []
  const data = fixture()
  const store: ExtractionStore = {
    createRun: async () => { events.push('run:stage'); return 'created' },
    writeSourceRows: async (_boqId, _runId, rows) => { events.push('rows:write'); batches.push(rows.length) },
    verifySourceRows: async () => { events.push('rows:verify'); return { count: data.run.sourceRowCount, checksum: data.run.sourceRowChecksum } },
    finalizeBoqAndRun: async () => { events.push('boq+run:finalize'); return 'finalized' },
    getReadyImport: async () => null,
    deleteRunTree: async () => { events.push('run:delete') },
    listExpiredStagingRuns: async () => [],
    ...overrides,
  }
  return { ...data, store, events, batches }
}

test('staged persistence writes no more than 200 rows per batch and finalizes after verification', async () => {
  const harness = storeHarness()
  const data = fixture(401)
  harness.run.sourceRowCount = 401
  await persistStagedRun({ ...data, run: harness.run }, harness.store)
  assert.deepEqual(harness.batches, [200, 200, 1])
  assert.deepEqual(harness.events, ['run:stage', 'rows:write', 'rows:write', 'rows:write', 'rows:verify', 'boq+run:finalize'])
})

test('verification mismatch blocks finalize and removes exact nested run tree', async () => {
  const harness = storeHarness({ verifySourceRows: async () => ({ count: 2, checksum: 'wrong' }) })
  await assert.rejects(() => persistStagedRun(harness, harness.store), /verification failed/i)
  assert.equal(harness.events.includes('boq+run:finalize'), false)
  assert.equal(harness.events.at(-1), 'run:delete')
})

test('commit-then-reject returns the stored ready BOQ without cleanup', async () => {
  const ready = { ...fixture().boq, createdAt: 'now', updatedAt: 'now' } as Boq
  const harness = storeHarness({
    finalizeBoqAndRun: async () => { throw new Error('deadline') },
    getReadyImport: async () => ({ boq: ready, run: { ...fixture().run, status: 'ready' } }),
  })
  const result = await persistStagedRun(harness, harness.store)
  assert.equal(result, ready)
  assert.equal(harness.events.includes('run:delete'), false)
})

test('duplicate ready run is idempotent and skips evidence rewrites', async () => {
  const ready = { ...fixture().boq, createdAt: 'now', updatedAt: 'now' } as Boq
  const harness = storeHarness({
    createRun: async () => 'exists_ready',
    writeSourceRows: async () => { throw new Error('must not rewrite') },
    getReadyImport: async () => ({ boq: ready, run: { ...fixture().run, status: 'ready' } }),
  })
  assert.equal(await persistStagedRun(harness, harness.store), ready)
})

test('unknown store creation result fails closed and cleans staging evidence', async () => {
  const harness = storeHarness({
    createRun: async () => 'malformed' as 'created',
  })
  await assert.rejects(() => persistStagedRun(harness, harness.store), /store result/i)
  assert.equal(harness.events.at(-1), 'run:delete')
})

test('unknown finalize outcome and failed cleanup preserves recovery evidence', async () => {
  const harness = storeHarness({
    finalizeBoqAndRun: async () => { throw new Error('deadline') },
    getReadyImport: async () => { throw new Error('read unavailable') },
    deleteRunTree: async () => { throw new Error('cleanup unavailable') },
  })
  await assert.rejects(
    () => persistStagedRun(harness, harness.store),
    (error) => error instanceof ExtractionCleanupUncertainError,
  )
})

test('cancellation after row verification cleans staging before finalize', async () => {
  const controller = new AbortController()
  const harness = storeHarness({
    verifySourceRows: async () => { controller.abort(); return { count: 3, checksum: 'checksum' } },
  })
  await assert.rejects(() => persistStagedRun(harness, harness.store, controller.signal), /cancel/i)
  assert.equal(harness.events.includes('boq+run:finalize'), false)
  assert.equal(harness.events.at(-1), 'run:delete')
})

test('expired staging cleanup is bounded and delegates complete run-tree deletion', async () => {
  const deleted: string[] = []
  const harness = storeHarness({
    listExpiredStagingRuns: async (_cutoff, limit) => {
      assert.equal(limit, 2)
      return [{ boqId: 'b1', runId: 'r1' }, { boqId: 'b2', runId: 'r2' }]
    },
    deleteRunTree: async (boqId, runId) => { deleted.push(`${boqId}/${runId}`) },
  })
  assert.equal(await cleanupExpiredStagingRuns(harness.store, '2026-07-20T00:00:00Z', 2), 2)
  assert.deepEqual(deleted, ['b1/r1', 'b2/r2'])
})
