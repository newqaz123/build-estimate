import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseExtractedPricingSnapshot,
  parsePricingNormalization,
  parseProposedCatalogMetadata,
  parseReviewerPricingSnapshot,
  parseRowRole,
  parseSuggestionVersions,
  ROW_ROLES,
} from './actionable-review-types'

test('parseRowRole accepts the closed role domain and rejects unknown values', () => {
  for (const role of ROW_ROLES) {
    assert.equal(parseRowRole(role), role)
  }
  for (const value of [
    'item',
    'header',
    'PRICED_ITEM',
    '',
    ' priced_item',
    null,
    undefined,
    1,
    true,
    {},
  ]) {
    assert.throws(() => parseRowRole(value), /row role|invalid/i)
  }
})

test('parseSuggestionVersions requires complete fingerprints and rejects extras', () => {
  const valid = {
    extractionFingerprint: 'ext-1',
    boqSectionsFingerprint: 'boq-1',
    catalogFingerprint: 'cat-1',
    conversionFingerprint: 'conv-1',
    promptVersion: 'prompt-v1',
  }
  assert.deepEqual(parseSuggestionVersions(valid), valid)
  assert.deepEqual(
    parseSuggestionVersions({ ...valid, modelVersion: 'model-v1' }),
    { ...valid, modelVersion: 'model-v1' },
  )

  assert.throws(
    () => parseSuggestionVersions({
      extractionFingerprint: 'ext-1',
      boqSectionsFingerprint: 'boq-1',
      catalogFingerprint: 'cat-1',
      conversionFingerprint: 'conv-1',
      // missing promptVersion
    }),
    /fingerprint|version|invalid/i,
  )
  assert.throws(
    () => parseSuggestionVersions({
      ...valid,
      promptVersion: '   ',
    }),
    /fingerprint|version|invalid/i,
  )
  assert.throws(
    () => parseSuggestionVersions({
      ...valid,
      modelVersion: '',
    }),
    /fingerprint|version|invalid/i,
  )
  assert.throws(
    () => parseSuggestionVersions({
      ...valid,
      unexpected: true,
    }),
    /fingerprint|version|invalid/i,
  )
  assert.throws(() => parseSuggestionVersions(null), /fingerprint|version|invalid/i)
})

test('parseExtractedPricingSnapshot keeps decimal fields canonical and rejects incomplete payloads', () => {
  assert.deepEqual(
    parseExtractedPricingSnapshot({
      description: 'C25 concrete',
      unit: 'm3',
      quantity: '12.500',
      materialRate: '100.00',
      labourRate: '0',
      total: '1250.0',
    }),
    {
      description: 'C25 concrete',
      unit: 'm3',
      quantity: '12.5',
      materialRate: '100',
      labourRate: '0',
      total: '1250',
    },
  )

  assert.throws(
    () => parseExtractedPricingSnapshot({
      description: 'C25 concrete',
      unit: 'm3',
      quantity: '12.5',
      materialRate: '100',
      labourRate: '0',
      // missing total
    }),
    /pricing|invalid/i,
  )
  assert.throws(
    () => parseExtractedPricingSnapshot({
      description: 'C25 concrete',
      unit: 'm3',
      quantity: '1e3',
      materialRate: '100',
      labourRate: '0',
      total: '100000',
    }),
    /decimal|invalid|numeric/i,
  )
})

test('parseReviewerPricingSnapshot requires confirmation metadata and correction reason on divergence', () => {
  const extracted = {
    description: 'C25 concrete',
    unit: 'm3',
    quantity: '12.5',
    materialRate: '100',
    labourRate: '0',
    total: '1250',
  }

  assert.deepEqual(
    parseReviewerPricingSnapshot({
      ...extracted,
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    {
      ...extracted,
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    },
  )

  assert.deepEqual(
    parseReviewerPricingSnapshot({
      ...extracted,
      quantity: '13',
      total: '1300',
      correctionReason: 'Quantity takeoff correction',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    {
      ...extracted,
      quantity: '13',
      total: '1300',
      correctionReason: 'Quantity takeoff correction',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    },
  )

  assert.throws(
    () => parseReviewerPricingSnapshot({
      ...extracted,
      quantity: '13',
      total: '1300',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    /correction/i,
  )
  assert.throws(
    () => parseReviewerPricingSnapshot({
      ...extracted,
      quantity: '13',
      total: '1300',
      correctionReason: '   ',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    /correction/i,
  )
  assert.throws(
    () => parseReviewerPricingSnapshot({
      ...extracted,
      confirmedAt: '2026-08-08T12:00:00.000Z',
    }, extracted),
    /confirm|invalid/i,
  )
})

test('description-only reviewer edits succeed without correctionReason', () => {
  const extracted = {
    description: 'C25 concrete',
    unit: 'm3',
    quantity: '12.5',
    materialRate: '100',
    labourRate: '0',
    total: '1250',
  }

  assert.deepEqual(
    parseReviewerPricingSnapshot({
      ...extracted,
      description: 'C25 structural concrete (cleaned)',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    {
      ...extracted,
      description: 'C25 structural concrete (cleaned)',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    },
  )
})

test('unit-only reviewer edits require correctionReason', () => {
  const extracted = {
    description: 'C25 concrete',
    unit: 'm3',
    quantity: '12.5',
    materialRate: '100',
    labourRate: '0',
    total: '1250',
  }

  assert.throws(
    () => parseReviewerPricingSnapshot({
      ...extracted,
      unit: 'cu.m',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    /correction/i,
  )

  assert.deepEqual(
    parseReviewerPricingSnapshot({
      ...extracted,
      unit: 'cu.m',
      correctionReason: 'Normalized source unit alias',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    {
      ...extracted,
      unit: 'cu.m',
      correctionReason: 'Normalized source unit alias',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    },
  )
})

test('equivalent decimal spellings do not create false reviewer divergence', () => {
  const extracted = {
    description: 'C25 concrete',
    unit: 'm3',
    quantity: '12.50',
    materialRate: '100.00',
    labourRate: '0.0',
    total: '1250.0',
  }

  assert.deepEqual(
    parseReviewerPricingSnapshot({
      description: 'C25 concrete',
      unit: 'm3',
      quantity: '12.5',
      materialRate: '100',
      labourRate: '0',
      total: '1250',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    }, extracted),
    {
      description: 'C25 concrete',
      unit: 'm3',
      quantity: '12.5',
      materialRate: '100',
      labourRate: '0',
      total: '1250',
      confirmedAt: '2026-08-08T12:00:00.000Z',
      confirmedBy: 'user-1',
    },
  )
})

test('extracted pricing preserves empty description and unit strings', () => {
  assert.deepEqual(
    parseExtractedPricingSnapshot({
      description: '',
      unit: '',
      quantity: '1',
      materialRate: '0',
      labourRate: '0',
      total: '0',
    }),
    {
      description: '',
      unit: '',
      quantity: '1',
      materialRate: '0',
      labourRate: '0',
      total: '0',
    },
  )
})

test('parsePricingNormalization rejects negative conversion factors and incomplete catalog metadata', () => {
  assert.deepEqual(
    parsePricingNormalization({
      catalogId: 'cat-1',
      catalogDescription: 'Concrete C25',
      catalogUnit: 'm3',
      ruleId: 'rule-1',
      catalogUnitsPerSourceUnit: '1.5',
      normalizedQuantity: '18.75',
      normalizedMaterialRate: '66.666667',
      normalizedLabourRate: '0',
      normalizedTotal: '1250',
    }),
    {
      catalogId: 'cat-1',
      catalogDescription: 'Concrete C25',
      catalogUnit: 'm3',
      ruleId: 'rule-1',
      catalogUnitsPerSourceUnit: '1.5',
      normalizedQuantity: '18.75',
      normalizedMaterialRate: '66.666667',
      normalizedLabourRate: '0',
      normalizedTotal: '1250',
    },
  )

  assert.throws(
    () => parsePricingNormalization({
      catalogId: 'cat-1',
      catalogDescription: 'Concrete C25',
      catalogUnit: 'm3',
      ruleId: 'rule-1',
      catalogUnitsPerSourceUnit: '-1.5',
      normalizedQuantity: '18.75',
      normalizedMaterialRate: '66.666667',
      normalizedLabourRate: '0',
      normalizedTotal: '1250',
    }),
    /conversion|factor|positive|invalid/i,
  )
  assert.throws(
    () => parsePricingNormalization({
      catalogId: 'cat-1',
      catalogDescription: 'Concrete C25',
      catalogUnit: 'm3',
      ruleId: 'rule-1',
      catalogUnitsPerSourceUnit: '0',
      normalizedQuantity: '0',
      normalizedMaterialRate: '0',
      normalizedLabourRate: '0',
      normalizedTotal: '0',
    }),
    /conversion|factor|positive|invalid/i,
  )
  assert.throws(
    () => parsePricingNormalization({
      catalogDescription: 'Concrete C25',
      catalogUnit: 'm3',
      ruleId: 'rule-1',
      catalogUnitsPerSourceUnit: '1',
      normalizedQuantity: '1',
      normalizedMaterialRate: '1',
      normalizedLabourRate: '0',
      normalizedTotal: '1',
    }),
    /invalid/i,
  )
})

test('parseProposedCatalogMetadata requires description, unit, and alias list', () => {
  assert.deepEqual(
    parseProposedCatalogMetadata({
      description: 'C25 concrete',
      unit: 'm3',
      aliases: ['C25', 'concrete c25'],
    }),
    {
      description: 'C25 concrete',
      unit: 'm3',
      aliases: ['C25', 'concrete c25'],
    },
  )
  assert.deepEqual(
    parseProposedCatalogMetadata({
      description: 'C25 concrete',
      unit: 'm3',
      category: 'Concrete',
      aliases: [],
    }),
    {
      description: 'C25 concrete',
      unit: 'm3',
      category: 'Concrete',
      aliases: [],
    },
  )

  assert.throws(
    () => parseProposedCatalogMetadata({
      description: 'C25 concrete',
      unit: 'm3',
    }),
    /alias|invalid/i,
  )
  assert.throws(
    () => parseProposedCatalogMetadata({
      description: '',
      unit: 'm3',
      aliases: [],
    }),
    /invalid/i,
  )
  assert.throws(
    () => parseProposedCatalogMetadata({
      description: 'C25 concrete',
      unit: 'm3',
      aliases: ['ok', ''],
    }),
    /alias|invalid/i,
  )
})
