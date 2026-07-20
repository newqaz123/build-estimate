import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq } from '@/lib/boq-schema'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import { createExtractionReviewHandler, type ExtractionReviewHandlerDependencies } from './review-api'

const boq = { id: 'boq-1', sections: [] } as unknown as Boq
const run = { id: 'run-1', boqId: 'boq-1', status: 'ready' } as BoqExtractionRun
const rows: BoqSourceRowV3[] = []

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
