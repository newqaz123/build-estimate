import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCatalogFingerprint,
  buildCatalogMappingCacheKey,
  buildConversionFingerprint,
  buildScopedSourceSignature,
  buildSourceSignature,
  isHashedCatalogMappingCacheKey,
  selectPreferredCatalogMapping,
  type ApprovedCatalogMapping,
  type CatalogMappingRecord,
} from './catalog-mapping-cache'

const humanMapping: CatalogMappingRecord = {
  sourceSignature: 'sig-a',
  catalogId: 'std-1',
  approvedBy: 'reviewer-1',
  approvedAt: '2026-08-08T10:00:00.000Z',
  origin: 'human',
}

const modelMapping: CatalogMappingRecord = {
  sourceSignature: 'sig-a',
  catalogId: 'std-model',
  approvedBy: 'model:gpt-test',
  approvedAt: '2026-08-08T11:00:00.000Z',
  origin: 'model',
  conversionRuleId: 'rule-1',
}

test('source signatures normalize description and unit only', () => {
  const left = buildSourceSignature({
    description: '  PVC  Pipe — 100mm ',
    unit: 'Length',
  })
  const right = buildSourceSignature({
    description: 'pvc pipe 100mm',
    unit: 'length',
  })
  assert.equal(left, right)
  assert.match(left, /^sha256:[a-f0-9]{64}$/)
})

test('source signatures ignore workspace scope and unitMap (scoped signature owns those)', () => {
  const plain = buildSourceSignature({
    description: 'Ready mix concrete C25',
    unit: 'cu m',
  })
  const scoped = buildScopedSourceSignature({
    description: 'Ready mix concrete C25',
    unit: 'cu m',
    unitMap: { 'cu m': 'm3' },
    workspaceScope: 'boq-prod-1',
  })
  assert.notEqual(plain, scoped)
  assert.match(scoped, /^sha256:[a-f0-9]{64}$/)
  // Mapping/AI revalidation signature stays stable across scope/unitMap.
  assert.equal(
    plain,
    buildSourceSignature({
      description: 'Ready mix concrete C25',
      unit: 'cu m',
    }),
  )
})

test('catalog fingerprint changes when a standard is archived', () => {
  const active = buildCatalogFingerprint([
    {
      id: 'std-1',
      description: 'Formwork slab',
      unit: 'm2',
      aliases: ['slab formwork'],
    },
  ])
  const archived = buildCatalogFingerprint([
    {
      id: 'std-1',
      description: 'Formwork slab',
      unit: 'm2',
      aliases: ['slab formwork'],
      archivedAt: '2026-08-01T00:00:00.000Z',
    },
  ])
  assert.notEqual(active, archived)
  assert.match(active, /^sha256:[a-f0-9]{64}$/)
})

test('conversion fingerprint changes when a rule is archived or versioned', () => {
  const active = buildConversionFingerprint([
    {
      id: 'rule-1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      catalogId: 'pipe-100',
      version: 1,
    },
  ])
  const archived = buildConversionFingerprint([
    {
      id: 'rule-1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      catalogId: 'pipe-100',
      version: 1,
      archivedAt: '2026-08-02T00:00:00.000Z',
    },
  ])
  const versioned = buildConversionFingerprint([
    {
      id: 'rule-1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      catalogId: 'pipe-100',
      version: 2,
    },
  ])
  assert.notEqual(active, archived)
  assert.notEqual(active, versioned)
})

test('mapping cache keys are hashed and versioned and invalidate on catalog or conversion drift', () => {
  const sourceSignature = buildSourceSignature({
    description: 'PVC pipe 100mm',
    unit: 'length',
  })
  const catalogFingerprint = buildCatalogFingerprint([
    { id: 'pipe-100', description: 'PVC pipe 100mm', unit: 'm' },
  ])
  const conversionFingerprint = buildConversionFingerprint([
    {
      id: 'rule-1',
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      catalogId: 'pipe-100',
      version: 1,
    },
  ])

  const key = buildCatalogMappingCacheKey({
    sourceSignature,
    workspaceScope: 'ws-1',
    catalogFingerprint,
    conversionFingerprint,
    promptVersion: 'prompt-v1',
    modelVersion: 'model-v1',
  })

  assert.equal(isHashedCatalogMappingCacheKey(key), true)
  assert.doesNotMatch(key, /PVC pipe|ws-1|prompt-v1/)

  const afterCatalogArchive = buildCatalogMappingCacheKey({
    sourceSignature,
    workspaceScope: 'ws-1',
    catalogFingerprint: buildCatalogFingerprint([
      {
        id: 'pipe-100',
        description: 'PVC pipe 100mm',
        unit: 'm',
        archivedAt: '2026-08-01T00:00:00.000Z',
      },
    ]),
    conversionFingerprint,
    promptVersion: 'prompt-v1',
    modelVersion: 'model-v1',
  })
  const afterRuleArchive = buildCatalogMappingCacheKey({
    sourceSignature,
    workspaceScope: 'ws-1',
    catalogFingerprint,
    conversionFingerprint: buildConversionFingerprint([
      {
        id: 'rule-1',
        sourceUnit: 'length',
        catalogUnit: 'm',
        catalogUnitsPerSourceUnit: '6',
        scope: 'catalog_item',
        catalogId: 'pipe-100',
        version: 1,
        archivedAt: '2026-08-02T00:00:00.000Z',
      },
    ]),
    promptVersion: 'prompt-v1',
    modelVersion: 'model-v1',
  })

  assert.notEqual(key, afterCatalogArchive)
  assert.notEqual(key, afterRuleArchive)
})

test('human-approved mappings outrank model advice', () => {
  assert.deepEqual(
    selectPreferredCatalogMapping(humanMapping, modelMapping),
    {
      sourceSignature: 'sig-a',
      catalogId: 'std-1',
      approvedBy: 'reviewer-1',
      approvedAt: '2026-08-08T10:00:00.000Z',
    } satisfies ApprovedCatalogMapping,
  )
  assert.deepEqual(
    selectPreferredCatalogMapping(null, modelMapping),
    {
      sourceSignature: 'sig-a',
      catalogId: 'std-model',
      approvedBy: 'model:gpt-test',
      approvedAt: '2026-08-08T11:00:00.000Z',
      conversionRuleId: 'rule-1',
    },
  )
  assert.equal(selectPreferredCatalogMapping(null, null), null)
})
