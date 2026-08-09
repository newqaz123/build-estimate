import assert from 'node:assert/strict'
import test from 'node:test'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import {
  shortlistCatalogCandidates,
  type CatalogShortlistInput,
} from './catalog-candidate-shortlist'
import type { ApprovedCatalogMapping } from './catalog-mapping-cache'

function rule(
  overrides: Partial<HumanApprovedCatalogConversionRule> &
    Pick<HumanApprovedCatalogConversionRule, 'id' | 'sourceUnit' | 'catalogUnit' | 'catalogId'>,
): HumanApprovedCatalogConversionRule {
  const base: HumanApprovedCatalogConversionRule = {
    id: overrides.id,
    sourceUnit: overrides.sourceUnit,
    catalogUnit: overrides.catalogUnit,
    catalogUnitsPerSourceUnit: overrides.catalogUnitsPerSourceUnit ?? '6',
    scope: overrides.scope ?? 'catalog_item',
    version: overrides.version ?? 1,
    approvedBy: overrides.approvedBy ?? 'admin-1',
    approvedAt: overrides.approvedAt ?? '2026-08-08T00:00:00.000Z',
  }
  if (overrides.scope === 'global') {
    return { ...base, scope: 'global' }
  }
  return {
    ...base,
    scope: 'catalog_item',
    catalogId: overrides.catalogId,
    ...(overrides.archivedAt !== undefined ? { archivedAt: overrides.archivedAt } : {}),
  }
}

function mapping(overrides: Partial<ApprovedCatalogMapping> & Pick<ApprovedCatalogMapping, 'catalogId'>): ApprovedCatalogMapping {
  return {
    sourceSignature: overrides.sourceSignature ?? 'sig-pipe',
    catalogId: overrides.catalogId,
    approvedBy: overrides.approvedBy ?? 'reviewer-1',
    approvedAt: overrides.approvedAt ?? '2026-08-08T12:00:00.000Z',
    ...(overrides.conversionRuleId !== undefined
      ? { conversionRuleId: overrides.conversionRuleId }
      : {}),
  }
}

function inputWithManyMatches(): CatalogShortlistInput {
  return {
    description: '100mm PVC pipe length',
    unit: 'length',
    sourceSignature: 'sig-pipe',
    unitMap: { length: 'length', m: 'm', ea: 'ea' },
    approvedMappings: [
      mapping({ catalogId: 'pipe-100', conversionRuleId: 'rule-pipe-100' }),
    ],
    conversionRules: [
      rule({
        id: 'rule-pipe-100',
        sourceUnit: 'length',
        catalogUnit: 'm',
        catalogId: 'pipe-100',
        catalogUnitsPerSourceUnit: '6',
      }),
      rule({
        id: 'rule-global-length',
        sourceUnit: 'length',
        catalogUnit: 'm',
        scope: 'global',
        catalogId: undefined as never,
      }),
    ],
    catalog: [
      {
        id: 'pipe-100',
        description: 'PVC pipe 100mm',
        unit: 'm',
        aliases: ['100mm PVC pipe'],
      },
      {
        id: 'pipe-100-exact',
        description: '100mm PVC pipe length',
        unit: 'length',
        aliases: [],
      },
      {
        id: 'pipe-alias',
        description: 'PVC pressure pipe 100 mm',
        unit: 'length',
        aliases: ['100mm PVC pipe length'],
      },
      {
        id: 'pipe-fuzzy-a',
        description: 'PVC pipe 100mm installation',
        unit: 'length',
        aliases: [],
      },
      {
        id: 'pipe-fuzzy-b',
        description: 'PVC pipe fittings 100mm',
        unit: 'length',
        aliases: [],
      },
      {
        id: 'pipe-convert',
        description: 'PVC pipe 100mm supply',
        unit: 'm',
        aliases: [],
      },
      {
        id: 'unrelated',
        description: 'Office cleaning',
        unit: 'ea',
        aliases: [],
      },
    ],
  }
}

function incompatibleUnitsInput(): CatalogShortlistInput {
  return {
    description: 'Structural concrete columns',
    unit: 'bag',
    unitMap: {},
    conversionRules: [],
    catalog: [
      {
        id: 'std-conc',
        description: 'Structural concrete columns',
        unit: 'm3',
        aliases: [],
      },
    ],
  }
}

test('returns no more than three candidates in safe priority order', () => {
  const candidates = shortlistCatalogCandidates(inputWithManyMatches())
  assert.ok(candidates.length <= 3)
  assert.equal(candidates[0]?.matchKind, 'approved_history')
  assert.equal(candidates[0]?.catalogId, 'pipe-100')
  assert.equal(candidates[0]?.conversionRuleId, 'rule-pipe-100')

  const kinds = candidates.map((candidate) => candidate.matchKind)
  const priority = {
    approved_history: 0,
    exact: 1,
    alias: 2,
    fuzzy: 3,
    conversion: 4,
  } as const
  for (let index = 1; index < kinds.length; index += 1) {
    assert.ok(priority[kinds[index]!] >= priority[kinds[index - 1]!])
  }
})

test('rejects incompatible units without an active conversion rule', () => {
  assert.deepEqual(shortlistCatalogCandidates(incompatibleUnitsInput()), [])
})

test('includes conversion candidates only when an active rule bridges units', () => {
  const candidates = shortlistCatalogCandidates({
    description: '100mm PVC pipe',
    unit: 'length',
    unitMap: {},
    conversionRules: [
      rule({
        id: 'rule-pipe-100',
        sourceUnit: 'length',
        catalogUnit: 'm',
        catalogId: 'pipe-100',
      }),
    ],
    catalog: [
      {
        id: 'pipe-100',
        description: '100mm PVC pipe',
        unit: 'm',
        aliases: [],
      },
      {
        id: 'pipe-other',
        description: '100mm PVC pipe',
        unit: 'm',
        aliases: [],
      },
    ],
  })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.catalogId, 'pipe-100')
  assert.equal(candidates[0]?.matchKind, 'conversion')
  assert.equal(candidates[0]?.conversionRuleId, 'rule-pipe-100')
})

test('item-specific conversion rules cannot leak across catalog IDs', () => {
  const candidates = shortlistCatalogCandidates({
    description: 'Copper pipe 15mm',
    unit: 'length',
    unitMap: {},
    conversionRules: [
      rule({
        id: 'rule-only-a',
        sourceUnit: 'length',
        catalogUnit: 'm',
        catalogId: 'pipe-a',
      }),
    ],
    catalog: [
      {
        id: 'pipe-a',
        description: 'Copper pipe 15mm',
        unit: 'm',
        aliases: [],
      },
      {
        id: 'pipe-b',
        description: 'Copper pipe 15mm',
        unit: 'm',
        aliases: [],
      },
    ],
  })

  assert.deepEqual(
    candidates.map((candidate) => candidate.catalogId),
    ['pipe-a'],
  )
  assert.equal(candidates[0]?.conversionRuleId, 'rule-only-a')
})

test('archived catalog entries are excluded from the shortlist', () => {
  const candidates = shortlistCatalogCandidates({
    description: 'Formwork slab',
    unit: 'm2',
    unitMap: { m2: 'm2' },
    catalog: [
      {
        id: 'std-formwork',
        description: 'Formwork slab',
        unit: 'm2',
        aliases: [],
        archivedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  })
  assert.deepEqual(candidates, [])
})

test('archived conversion rules do not unlock incompatible units', () => {
  const candidates = shortlistCatalogCandidates({
    description: '100mm PVC pipe',
    unit: 'length',
    unitMap: {},
    conversionRules: [
      rule({
        id: 'rule-archived',
        sourceUnit: 'length',
        catalogUnit: 'm',
        catalogId: 'pipe-100',
        archivedAt: '2026-08-01T00:00:00.000Z',
      }),
    ],
    catalog: [
      {
        id: 'pipe-100',
        description: '100mm PVC pipe',
        unit: 'm',
        aliases: [],
      },
    ],
  })
  assert.deepEqual(candidates, [])
})

test('approved history outranks exact alias fuzzy and conversion for the same catalog', () => {
  const candidates = shortlistCatalogCandidates({
    description: 'Reinforcement bar SD40 16mm',
    unit: 'ton',
    sourceSignature: 'sig-rebar',
    unitMap: {},
    approvedMappings: [mapping({ sourceSignature: 'sig-rebar', catalogId: 'std-rebar' })],
    catalog: [
      {
        id: 'std-rebar',
        description: 'Reinforcement bar SD40 16mm',
        unit: 'ton',
        aliases: ['rebar SD40 16 mm'],
      },
    ],
  })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.matchKind, 'approved_history')
  assert.equal(candidates[0]?.catalogId, 'std-rebar')
})

test('breaks score ties with stable catalog id ordering and caps at three', () => {
  const candidates = shortlistCatalogCandidates({
    description: 'Generic widget',
    unit: 'ea',
    unitMap: {},
    catalog: [
      { id: 'std-c', description: 'Generic widget pack', unit: 'ea', aliases: [] },
      { id: 'std-a', description: 'Generic widget kit', unit: 'ea', aliases: [] },
      { id: 'std-b', description: 'Generic widget set', unit: 'ea', aliases: [] },
      { id: 'std-d', description: 'Generic widget bundle', unit: 'ea', aliases: [] },
    ],
  })

  assert.equal(candidates.length, 3)
  assert.deepEqual(
    candidates.map((candidate) => candidate.catalogId),
    ['std-a', 'std-b', 'std-c'],
  )
  assert.ok(candidates.every((candidate) => candidate.matchKind === 'fuzzy'))
})

test('prefers exact over alias over compatible fuzzy over conversion', () => {
  const candidates = shortlistCatalogCandidates({
    description: 'Alpha item',
    unit: 'length',
    unitMap: {},
    conversionRules: [
      rule({
        id: 'rule-delta',
        sourceUnit: 'length',
        catalogUnit: 'm',
        catalogId: 'std-delta',
      }),
    ],
    catalog: [
      { id: 'std-exact', description: 'Alpha item', unit: 'length', aliases: [] },
      {
        id: 'std-alias',
        description: 'Alpha product',
        unit: 'length',
        aliases: ['Alpha item'],
      },
      {
        id: 'std-fuzzy',
        description: 'Alpha item installation accessory',
        unit: 'length',
        aliases: [],
      },
      {
        id: 'std-delta',
        description: 'Alpha item',
        unit: 'm',
        aliases: [],
      },
    ],
  })

  assert.deepEqual(
    candidates.map((candidate) => [candidate.catalogId, candidate.matchKind]),
    [
      ['std-exact', 'exact'],
      ['std-alias', 'alias'],
      ['std-fuzzy', 'fuzzy'],
    ],
  )
})

test('global conversion rules may apply to any catalog item with matching units', () => {
  const candidates = shortlistCatalogCandidates({
    description: 'Timber beam',
    unit: 'ft',
    unitMap: {},
    conversionRules: [
      {
        id: 'rule-ft-m',
        sourceUnit: 'ft',
        catalogUnit: 'm',
        catalogUnitsPerSourceUnit: '0.3048',
        scope: 'global',
        version: 1,
        approvedBy: 'admin-1',
        approvedAt: '2026-08-08T00:00:00.000Z',
      },
    ],
    catalog: [
      { id: 'beam-a', description: 'Timber beam', unit: 'm', aliases: [] },
      { id: 'beam-b', description: 'Timber beam graded', unit: 'm', aliases: [] },
    ],
  })

  assert.equal(candidates.length, 2)
  assert.ok(candidates.every((candidate) => candidate.matchKind === 'conversion'))
  assert.ok(candidates.every((candidate) => candidate.conversionRuleId === 'rule-ft-m'))
  assert.deepEqual(
    candidates.map((candidate) => candidate.catalogId),
    ['beam-a', 'beam-b'],
  )
})
