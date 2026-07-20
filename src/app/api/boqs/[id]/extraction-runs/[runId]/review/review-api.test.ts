import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq } from '@/lib/boq-schema'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import { createExtractionReviewHandler, type ExtractionReviewHandlerDependencies } from './review-api'

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
