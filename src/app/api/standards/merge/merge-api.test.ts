import assert from 'node:assert/strict'
import test from 'node:test'
import { CatalogMergeError } from '@/lib/catalog-merge'
import { createCatalogMergePostHandler, createCatalogMergeUndoHandler, type CatalogMergeDependencies } from './handler'

function deps(overrides: Partial<CatalogMergeDependencies> = {}) {
  const calls: string[] = []
  const value: CatalogMergeDependencies = {
    authenticate: async () => ({ user: { id: 'u' } }),
    preview: async (input) => { calls.push(`preview:${input.keepId}`); return { entries: [], suggested: { description: '', unit: '', aliases: [] }, combined: null, unitsDiffer: false, linkedRows: 0, conversions: 0 } },
    merge: async (input) => { calls.push(`merge:${input.keepId}:${input.mergeIds.join(',')}`); return { keptId: input.keepId, archivedIds: input.mergeIds, quoteRows: 2, estimateRows: 0, conversions: 0 } },
    undo: async (keepId) => { calls.push(`undo:${keepId}`); return { keptId: keepId, restoredIds: ['b'] } },
    ...overrides,
  }
  return { value, calls }
}

const post = (url: string, body: unknown) => new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

test('merge requires a session', async () => {
  const { value } = deps({ authenticate: async () => null })
  const response = await createCatalogMergePostHandler(value)(post('http://x/api/standards/merge', { keepId: 'a', mergeIds: ['b'] }))
  assert.equal(response.status, 401)
})

test('preview=1 never writes; plain POST merges', async () => {
  const { value, calls } = deps()
  const handler = createCatalogMergePostHandler(value)
  assert.equal((await handler(post('http://x/api/standards/merge?preview=1', { keepId: 'a', mergeIds: ['a', 'b'] }))).status, 200)
  const merged = await handler(post('http://x/api/standards/merge', { keepId: 'a', mergeIds: ['b'] }))
  assert.equal(merged.status, 200)
  assert.deepEqual(await merged.json(), { keptId: 'a', archivedIds: ['b'], quoteRows: 2, estimateRows: 0, conversions: 0 })
  assert.deepEqual(calls, ['preview:a', 'merge:a:b'])
})

test('merge validates input and maps merge errors to their status', async () => {
  const { value } = deps({ merge: async () => { throw new CatalogMergeError('clash', 409) } })
  const handler = createCatalogMergePostHandler(value)
  assert.equal((await handler(post('http://x/api/standards/merge', { keepId: 'a', mergeIds: [] }))).status, 400)
  assert.equal((await handler(new Request('http://x/api/standards/merge', { method: 'POST', body: '{' }))).status, 400)
  const clash = await handler(post('http://x/api/standards/merge', { keepId: 'a', mergeIds: ['b'] }))
  assert.equal(clash.status, 409)
  assert.deepEqual(await clash.json(), { error: 'clash' })
})

test('undo needs keepId and calls the store', async () => {
  const { value, calls } = deps()
  const handler = createCatalogMergeUndoHandler(value)
  assert.equal((await handler(post('http://x/api/standards/merge/undo', {}))).status, 400)
  assert.equal((await handler(post('http://x/api/standards/merge/undo', { keepId: 'a' }))).status, 200)
  assert.deepEqual(calls, ['undo:a'])
})
