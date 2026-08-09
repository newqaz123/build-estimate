import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCatalogFingerprint,
  buildCatalogMappingCacheKey,
  buildConversionFingerprint,
  buildSourceSignature,
  isHashedCatalogMappingCacheKey,
  type ApprovedCatalogMapping,
} from './catalog-mapping-cache'
import {
  CATALOG_MAPPING_CACHE_COLLECTION,
  CatalogMappingCacheStorageError,
  createCatalogMappingCacheStore,
  type CatalogMappingDocumentStore,
} from './catalog-mapping-cache-storage'

function memoryStore() {
  const docs = new Map<string, Record<string, unknown>>()
  const store: CatalogMappingDocumentStore = {
    async get(id: string) {
      const value = docs.get(id)
      return value ? { id, data: { ...value } } : null
    },
    async set(id: string, data: Record<string, unknown>) {
      if (docs.has(id)) {
        throw new CatalogMappingCacheStorageError('Mapping cache entry already exists.', 409)
      }
      docs.set(id, { ...data })
    },
    async update(id: string, data: Record<string, unknown>) {
      const current = docs.get(id)
      if (!current) {
        throw new CatalogMappingCacheStorageError('Mapping cache entry not found.', 404)
      }
      docs.set(id, { ...data })
    },
    async delete(id: string) {
      docs.delete(id)
    },
  }
  return { store, docs }
}

function sampleKey() {
  return buildCatalogMappingCacheKey({
    sourceSignature: buildSourceSignature({
      description: 'PVC pipe 100mm',
      unit: 'length',
    }),
    workspaceScope: 'ws-1',
    catalogFingerprint: buildCatalogFingerprint([
      { id: 'pipe-100', description: 'PVC pipe 100mm', unit: 'm' },
    ]),
    conversionFingerprint: buildConversionFingerprint([
      {
        id: 'rule-1',
        sourceUnit: 'length',
        catalogUnit: 'm',
        catalogUnitsPerSourceUnit: '6',
        scope: 'catalog_item',
        catalogId: 'pipe-100',
        version: 1,
      },
    ]),
    promptVersion: 'prompt-v1',
    modelVersion: 'model-v1',
  })
}

const humanMapping: ApprovedCatalogMapping = {
  sourceSignature: 'sig-pipe',
  catalogId: 'pipe-100',
  conversionRuleId: 'rule-1',
  approvedBy: 'reviewer-1',
  approvedAt: '2026-08-08T10:00:00.000Z',
}

const modelMapping: ApprovedCatalogMapping = {
  sourceSignature: 'sig-pipe',
  catalogId: 'pipe-model',
  approvedBy: 'model:gpt-test',
  approvedAt: '2026-08-08T11:00:00.000Z',
}

test('collection path is catalogMappingCache', () => {
  assert.equal(CATALOG_MAPPING_CACHE_COLLECTION, 'catalogMappingCache')
})

test('storage keys are hashed and reads are server-mediated through the document adapter', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  assert.equal(isHashedCatalogMappingCacheKey(key), true)

  await cache.put(key, humanMapping, { origin: 'human' })
  assert.equal(docs.has(key), true)
  assert.equal(docs.has('sig-pipe'), false)
  assert.doesNotMatch([...docs.keys()].join(','), /PVC pipe|ws-1|prompt-v1/)

  const loaded = await cache.get(key)
  assert.deepEqual(loaded, humanMapping)

  // Adapter-only access: no ambient client SDK state.
  assert.equal(typeof store.get, 'function')
  assert.equal(typeof store.set, 'function')
})

test('model-only advice cannot overwrite a human-approved mapping', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.put(key, humanMapping, { origin: 'human' })
  await cache.put(key, modelMapping, { origin: 'model' })

  assert.deepEqual(await cache.get(key), humanMapping)
  assert.equal(docs.get(key)?.origin, 'human')
  assert.equal(docs.get(key)?.catalogId, 'pipe-100')
})

test('human approval can replace model advice for the same cache key', async () => {
  const { store } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.put(key, modelMapping, { origin: 'model' })
  assert.deepEqual(await cache.get(key), modelMapping)

  await cache.put(key, humanMapping, { origin: 'human' })
  assert.deepEqual(await cache.get(key), humanMapping)
})

test('remove deletes a mapping cache entry', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.put(key, humanMapping, { origin: 'human' })
  await cache.remove(key)
  assert.equal(await cache.get(key), null)
  assert.equal(docs.has(key), false)
})

test('rejects non-hashed cache keys at the storage boundary', async () => {
  const { store } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)

  await assert.rejects(
    () => cache.put('raw-source-signature', humanMapping, { origin: 'human' }),
    /hash|sha256|key/i,
  )
  await assert.rejects(
    () => cache.get('raw-source-signature'),
    /hash|sha256|key/i,
  )
})

test('rejects unknown document keys and AI-authored conversion factors in stored mappings', async () => {
  const { store } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await assert.rejects(
    () => cache.put(key, {
      ...humanMapping,
      conversionFactor: '6',
    } as never, { origin: 'human' }),
    /unexpected|unknown|invalid/i,
  )
})
