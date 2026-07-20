import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq } from '@/lib/boq-schema'
import { ReextractError } from '@/lib/boq-reextract'
import type { ReextractHandlerDependencies } from './handler'
import { createReextractHandler } from './handler'

function deps(overrides: Partial<ReextractHandlerDependencies> = {}): ReextractHandlerDependencies {
  return {
    authenticate: async () => ({ user: { id: 'user-1' } }),
    getBoq: async () => null,
    loadSource: async () => new Uint8Array(),
    parsePdfWithDocling: async () => ({ contractVersion: 2 }) as never,
    createRunId: () => 'run-1', now: () => new Date(), getEndpoint: async () => 'http://docling.test',
    persistRun: async () => { throw new Error('not called') },
    ...overrides,
  }
}

test('re-extract authenticates before reading a retained source', async () => {
  let reads = 0
  const response = await createReextractHandler(deps({ authenticate: async () => null, getBoq: async () => { reads += 1; return null } }))(
    new Request('https://example.test', { method: 'POST' }), { params: Promise.resolve({ id: 'boq-1' }) },
  )
  assert.equal(response.status, 401)
  assert.equal(reads, 0)
})

test('re-extract reports a missing source without modifying the canonical BOQ', async () => {
  const response = await createReextractHandler(deps())(new Request('https://example.test', { method: 'POST' }), { params: Promise.resolve({ id: 'boq-1' }) })
  assert.equal(response.status, 404)
})

test('re-extract returns 409 when approval wins the final persistence race', async () => {
  const sourceRow = {
    id: 'row-1', page: 1, table: 1, row: 1, section: null, headers: [], rawCells: ['item'],
    rawText: 'item', confidence: 1, warnings: [], classification: 'clear',
  }
  const response = await createReextractHandler(deps({
    getBoq: async () => ({
      id: 'boq-1', status: 'draft', sourceStoragePath: 'boqs/boq-1/source.pdf',
      sourceFileName: 'source.pdf', sections: [], activeExtractionRunId: 'run-original',
    }) as unknown as Boq,
    parsePdfWithDocling: async () => ({
      contractVersion: 3, documentName: 'source.pdf', pageCount: 1, documentText: '', totalItems: 0,
      metadata: {
        vendor: { value: '', confidence: 1 }, project: { value: '', confidence: 1 },
        workType: { value: '', confidence: 1 }, date: { value: '', confidence: 1 },
      },
      sections: [], sourceRows: [sourceRow], warnings: [],
      reconciliation: { sourceTotal: 0, derivedTotal: 0, reconciled: true },
      reviewTargeting: { candidateRowIds: [] },
    }) as never,
    persistRun: async () => { throw new ReextractError('read_only') },
  }))(
    new Request('https://example.test', { method: 'POST' }),
    { params: Promise.resolve({ id: 'boq-1' }) },
  )

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'Approved BOQs are read-only' })
})
