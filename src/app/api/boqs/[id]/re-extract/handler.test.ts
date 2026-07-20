import assert from 'node:assert/strict'
import test from 'node:test'
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
