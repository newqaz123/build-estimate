import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CATALOG_CONVERSION_RULES_COLLECTION,
  CatalogConversionStorageError,
  createCatalogConversionRuleStore,
  parseHumanApprovedCatalogConversionRule,
  type CatalogConversionRuleDocumentStore,
} from './catalog-conversion-storage'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'

function memoryStore() {
  const docs = new Map<string, Record<string, unknown>>()
  const store: CatalogConversionRuleDocumentStore = {
    async get(id: string) {
      const value = docs.get(id)
      return value ? { id, data: { ...value } } : null
    },
    async set(id: string, data: Record<string, unknown>) {
      if (docs.has(id)) {
        throw new CatalogConversionStorageError('Conversion rule already exists.', 409)
      }
      docs.set(id, { ...data })
    },
    async update(id: string, patch: Record<string, unknown>) {
      const current = docs.get(id)
      if (!current) {
        throw new CatalogConversionStorageError('Conversion rule not found.', 404)
      }
      docs.set(id, { ...current, ...patch })
    },
    async list(limit: number) {
      return [...docs.entries()]
        .slice(0, limit)
        .map(([id, data]) => ({ id, data: { ...data } }))
    },
  }
  return { store, docs }
}

const baseCreateInput = {
  sourceUnit: 'length',
  catalogUnit: 'm',
  catalogUnitsPerSourceUnit: '6',
  scope: 'catalog_item' as const,
  catalogId: 'pipe-100',
}

test('collection path is catalogConversionRules', () => {
  assert.equal(CATALOG_CONVERSION_RULES_COLLECTION, 'catalogConversionRules')
})

test('creates a catalog-item rule with server actor metadata and positive version', async () => {
  const { store, docs } = memoryStore()
  const rules = createCatalogConversionRuleStore(store, {
    now: () => new Date('2026-08-08T10:00:00.000Z'),
    createId: () => 'rule-1',
  })

  const created = await rules.create(baseCreateInput, { actorId: 'admin-1' })
  assert.equal(created.id, 'rule-1')
  assert.equal(created.scope, 'catalog_item')
  assert.equal(created.catalogId, 'pipe-100')
  assert.equal(created.catalogUnitsPerSourceUnit, '6')
  assert.equal(created.version, 1)
  assert.equal(created.approvedBy, 'admin-1')
  assert.equal(created.approvedAt, '2026-08-08T10:00:00.000Z')
  assert.equal(created.archivedAt, undefined)
  assert.equal(docs.has('rule-1'), true)
})

test('creates a global rule without catalogId', async () => {
  const { store } = memoryStore()
  const rules = createCatalogConversionRuleStore(store, {
    now: () => new Date('2026-08-08T10:00:00.000Z'),
    createId: () => 'global-1',
  })

  const created = await rules.create({
    sourceUnit: 'ft',
    catalogUnit: 'm',
    catalogUnitsPerSourceUnit: '0.3048',
    scope: 'global',
  }, { actorId: 'admin-1' })

  assert.equal(created.scope, 'global')
  assert.equal('catalogId' in created, false)
  assert.equal(created.catalogUnitsPerSourceUnit, '0.3048')
})

test('rejects identity scope and AI-origin fields at the storage boundary', async () => {
  const { store } = memoryStore()
  const rules = createCatalogConversionRuleStore(store, {
    now: () => new Date('2026-08-08T10:00:00.000Z'),
    createId: () => 'bad-1',
  })

  await assert.rejects(
    () => rules.create({
      sourceUnit: 'm',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '1',
      scope: 'identity',
    } as never, { actorId: 'admin-1' }),
    /identity/i,
  )

  await assert.rejects(
    () => rules.create({
      ...baseCreateInput,
      modelVersion: 'gpt-test',
    } as never, { actorId: 'admin-1' }),
    /unexpected|unknown|invalid/i,
  )

  await assert.rejects(
    () => rules.create({
      ...baseCreateInput,
      origin: 'ai',
    } as never, { actorId: 'admin-1' }),
    /unexpected|unknown|invalid/i,
  )
})

test('rejects zero/negative factors, bad versions, and scope/catalogId mismatches when parsing', () => {
  assert.throws(
    () => parseHumanApprovedCatalogConversionRule({
      id: 'r1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '0',
      scope: 'global',
      version: 1,
      approvedBy: 'a',
      approvedAt: '2026-08-08T00:00:00.000Z',
    }),
    /factor|positive/i,
  )
  assert.throws(
    () => parseHumanApprovedCatalogConversionRule({
      id: 'r1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '-1',
      scope: 'global',
      version: 1,
      approvedBy: 'a',
      approvedAt: '2026-08-08T00:00:00.000Z',
    }),
    /factor|positive/i,
  )
  assert.throws(
    () => parseHumanApprovedCatalogConversionRule({
      id: 'r1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'global',
      version: 0,
      approvedBy: 'a',
      approvedAt: '2026-08-08T00:00:00.000Z',
    }),
    /version/i,
  )
  assert.throws(
    () => parseHumanApprovedCatalogConversionRule({
      id: 'r1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'global',
      catalogId: 'should-not-exist',
      version: 1,
      approvedBy: 'a',
      approvedAt: '2026-08-08T00:00:00.000Z',
    }),
    /catalogId|global/i,
  )
  assert.throws(
    () => parseHumanApprovedCatalogConversionRule({
      id: 'r1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      version: 1,
      approvedBy: 'a',
      approvedAt: '2026-08-08T00:00:00.000Z',
    }),
    /catalogId/i,
  )
  assert.throws(
    () => parseHumanApprovedCatalogConversionRule({
      id: 'r1',
      sourceUnit: 'm',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '1',
      scope: 'identity',
      version: 1,
      approvedBy: 'a',
      approvedAt: '2026-08-08T00:00:00.000Z',
    }),
    /identity/i,
  )
})

test('get returns parsed active rules and archive marks archivedAt', async () => {
  const { store } = memoryStore()
  const rules = createCatalogConversionRuleStore(store, {
    now: () => new Date('2026-08-08T10:00:00.000Z'),
    createId: () => 'rule-archive',
  })

  await rules.create(baseCreateInput, { actorId: 'admin-1' })
  const loaded = await rules.get('rule-archive')
  assert.equal(loaded?.id, 'rule-archive')
  assert.equal(loaded?.archivedAt, undefined)

  const archived = await rules.archive('rule-archive', {
    actorId: 'admin-2',
    archivedAt: '2026-08-09T00:00:00.000Z',
  })
  assert.equal(archived.archivedAt, '2026-08-09T00:00:00.000Z')
  assert.equal((await rules.get('rule-archive'))?.archivedAt, '2026-08-09T00:00:00.000Z')
})

test('list is bounded and does not require a composite index query shape', async () => {
  const { store } = memoryStore()
  let n = 0
  const rules = createCatalogConversionRuleStore(store, {
    now: () => new Date('2026-08-08T10:00:00.000Z'),
    createId: () => `rule-${n++}`,
  })

  for (let i = 0; i < 3; i += 1) {
    await rules.create({
      ...baseCreateInput,
      catalogId: `item-${i}`,
    }, { actorId: 'admin-1' })
  }

  const page = await rules.list({ limit: 2 })
  assert.equal(page.length, 2)
  await assert.rejects(() => rules.list({ limit: 0 }), /limit/i)
  await assert.rejects(() => rules.list({ limit: 501 }), /limit/i)
})

test('parseHumanApprovedCatalogConversionRule accepts a valid stored document', () => {
  const parsed = parseHumanApprovedCatalogConversionRule({
    id: 'rule-ok',
    sourceUnit: 'length',
    catalogUnit: 'm',
    catalogUnitsPerSourceUnit: '6.0',
    scope: 'catalog_item',
    catalogId: 'pipe-100',
    version: 2,
    approvedBy: 'admin',
    approvedAt: '2026-08-08T00:00:00.000Z',
  })
  assert.equal(parsed.catalogUnitsPerSourceUnit, '6')
  assert.equal(parsed.version, 2)
  assert.equal(parsed.catalogId, 'pipe-100')
})

test('rejects unknown keys when parsing stored documents', () => {
  assert.throws(
    () => parseHumanApprovedCatalogConversionRule({
      id: 'rule-ok',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'global',
      version: 1,
      approvedBy: 'admin',
      approvedAt: '2026-08-08T00:00:00.000Z',
      aiSuggestion: true,
    }),
    /unexpected|unknown|invalid/i,
  )
})

test('create rejects global rules that include catalogId and item rules without it', async () => {
  const { store } = memoryStore()
  const rules = createCatalogConversionRuleStore(store, {
    now: () => new Date('2026-08-08T10:00:00.000Z'),
    createId: () => 'rule-bad-scope',
  })

  await assert.rejects(
    () => rules.create({
      sourceUnit: 'ft',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '0.3048',
      scope: 'global',
      catalogId: 'nope',
    }, { actorId: 'admin-1' }),
    /catalogId|global/i,
  )
  await assert.rejects(
    () => rules.create({
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
    }, { actorId: 'admin-1' }),
    /catalogId/i,
  )
})

// Keep a type-level reminder that stored documents are human-approved only.
test('HumanApprovedCatalogConversionRule never uses identity scope', () => {
  const sample: HumanApprovedCatalogConversionRule = {
    id: 'x',
    sourceUnit: 'a',
    catalogUnit: 'b',
    catalogUnitsPerSourceUnit: '2',
    scope: 'global',
    version: 1,
    approvedBy: 'a',
    approvedAt: '2026-08-08T00:00:00.000Z',
  }
  assert.notEqual(sample.scope, 'identity')
})
