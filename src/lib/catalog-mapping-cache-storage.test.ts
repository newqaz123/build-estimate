import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCatalogFingerprint,
  buildCatalogMappingCacheKey,
  buildConversionFingerprint,
  buildSourceSignature,
  isHashedCatalogMappingCacheKey,
  type ApprovedCatalogMapping,
  type CatalogMappingCache,
} from './catalog-mapping-cache'
import {
  CATALOG_MAPPING_CACHE_COLLECTION,
  CatalogMappingCacheStorageError,
  createCatalogMappingCacheStore,
  type CatalogMappingCacheStore,
  type CatalogMappingDocumentStore,
} from './catalog-mapping-cache-storage'

function memoryStore() {
  const docs = new Map<string, Record<string, unknown>>()
  const chain = new Map<string, Promise<unknown>>()

  async function withKeyLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = chain.get(id) ?? Promise.resolve()
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    chain.set(
      id,
      previous.then(() => gate).catch(() => gate),
    )
    await previous.catch(() => undefined)
    try {
      return await work()
    } finally {
      release(undefined)
    }
  }

  const store: CatalogMappingDocumentStore = {
    async get(id: string) {
      const value = docs.get(id)
      return value ? { id, data: { ...value } } : null
    },
    async delete(id: string) {
      docs.delete(id)
    },
    async runAtomic(id, mutate) {
      return withKeyLock(id, async () => {
        const current = docs.has(id) ? { ...docs.get(id)! } : null
        const next = mutate(current)
        if (next === null) return 'skipped' as const
        docs.set(id, { ...next })
        return 'applied' as const
      })
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

test('public CatalogMappingCache.put is human-only and has no origin option', async () => {
  const { store, docs } = memoryStore()
  const concrete: CatalogMappingCacheStore = createCatalogMappingCacheStore(store)
  // Exact public interface shape: get/put/remove only (putModel is additive on concrete store).
  const cache: CatalogMappingCache = concrete
  const key = sampleKey()

  assert.equal(isHashedCatalogMappingCacheKey(key), true)
  // Exact public interface: put(key, mapping) only — always human origin.
  await cache.put(key, humanMapping)
  assert.equal(docs.get(key)?.origin, 'human')
  assert.deepEqual(await cache.get(key), humanMapping)
  assert.equal(cache.put.length, 2)

  assert.equal(typeof concrete.putModel, 'function')
  assert.equal(concrete.putModel.length, 2)
  // Public put must not accept an origin options bag (arity stays 2).
  await cache.put(key, {
    ...humanMapping,
    catalogId: 'pipe-human-replaced',
  })
  assert.equal(docs.get(key)?.origin, 'human')
  assert.equal((await cache.get(key))?.catalogId, 'pipe-human-replaced')
})

test('storage keys are hashed and reads are server-mediated through the document adapter', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.put(key, humanMapping)
  assert.equal(docs.has(key), true)
  assert.equal(docs.has('sig-pipe'), false)
  assert.doesNotMatch([...docs.keys()].join(','), /PVC pipe|ws-1|prompt-v1/)

  const loaded = await cache.get(key)
  assert.deepEqual(loaded, humanMapping)

  assert.equal(typeof store.get, 'function')
  assert.equal(typeof store.runAtomic, 'function')
})

test('putModel cannot overwrite a human-approved mapping', async () => {
  const { store, docs } = memoryStore()
  const cache: CatalogMappingCacheStore = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.put(key, humanMapping)
  await cache.putModel(key, modelMapping)

  assert.deepEqual(await cache.get(key), humanMapping)
  assert.equal(docs.get(key)?.origin, 'human')
  assert.equal(docs.get(key)?.catalogId, 'pipe-100')
})

test('putModel can create model advice when the key is empty', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.putModel(key, modelMapping)
  // Stored as advice only: get() never serves model advice as an approved mapping.
  assert.equal(await cache.get(key), null)
  assert.equal(docs.get(key)?.origin, 'model')
})

test('get serves only human-approved mappings (model advice is never approved history)', async () => {
  const { store } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.putModel(key, modelMapping)
  assert.equal(await cache.get(key), null)
  await cache.put(key, humanMapping)
  assert.deepEqual(await cache.get(key), humanMapping)
})

test('human put can replace model advice for the same cache key', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.putModel(key, modelMapping)
  assert.equal(await cache.get(key), null)

  await cache.put(key, humanMapping)
  assert.deepEqual(await cache.get(key), humanMapping)
  assert.equal(docs.get(key)?.origin, 'human')
})

test('concurrent model write cannot win over a concurrent human write', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  // Deterministic race: many interleaved human/model writers. Final origin must be human
  // whenever at least one successful human put is in the batch.
  for (let round = 0; round < 20; round += 1) {
    docs.delete(key)
    const writers: Array<Promise<void>> = []
    for (let index = 0; index < 8; index += 1) {
      if (index % 2 === 0) {
        writers.push(cache.putModel(key, {
          ...modelMapping,
          catalogId: `pipe-model-${round}-${index}`,
          approvedAt: `2026-08-08T11:00:0${index}.000Z`,
        }))
      } else {
        writers.push(cache.put(key, {
          ...humanMapping,
          catalogId: `pipe-human-${round}-${index}`,
          approvedAt: `2026-08-08T10:00:0${index}.000Z`,
        }))
      }
    }
    await Promise.all(writers)
    assert.equal(docs.get(key)?.origin, 'human', `round ${round} lost human origin`)
    const loaded = await cache.get(key)
    assert.ok(loaded)
    assert.match(loaded.catalogId, /^pipe-human-/)
  }
})

test('remove deletes a mapping cache entry', async () => {
  const { store, docs } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)
  const key = sampleKey()

  await cache.put(key, humanMapping)
  await cache.remove(key)
  assert.equal(await cache.get(key), null)
  assert.equal(docs.has(key), false)
})

test('rejects non-hashed cache keys at the storage boundary', async () => {
  const { store } = memoryStore()
  const cache = createCatalogMappingCacheStore(store)

  await assert.rejects(
    () => cache.put('raw-source-signature', humanMapping),
    /hash|sha256|key/i,
  )
  await assert.rejects(
    () => cache.putModel('raw-source-signature', modelMapping),
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
    } as never),
    /unexpected|unknown|invalid/i,
  )
  await assert.rejects(
    () => cache.putModel(key, {
      ...modelMapping,
      conversionFactor: '6',
    } as never),
    /unexpected|unknown|invalid/i,
  )
})
