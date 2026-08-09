import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewerPricingSnapshot } from './actionable-review-types'
import {
  IDENTITY_CONVERSION_RULE_VERSION,
  identityConversionRule,
  normalizePricingWithRule,
  type HumanApprovedCatalogConversionRule,
} from './catalog-conversion'

function reviewerPricing(
  overrides: Partial<ReviewerPricingSnapshot> = {},
): ReviewerPricingSnapshot {
  return {
    description: 'PVC Pipe 100 mm',
    unit: 'length',
    quantity: '6',
    materialRate: '6000',
    labourRate: '0',
    total: '36000',
    confirmedAt: '2026-08-08T12:00:00.000Z',
    confirmedBy: 'reviewer-1',
    ...overrides,
  }
}

function conversionRule(
  overrides: Partial<HumanApprovedCatalogConversionRule> = {},
): HumanApprovedCatalogConversionRule {
  const scope = overrides.scope ?? (overrides.catalogId ? 'catalog_item' : 'global')
  const rule: HumanApprovedCatalogConversionRule = {
    id: overrides.id ?? 'rule-length-m-1',
    sourceUnit: overrides.sourceUnit ?? 'length',
    catalogUnit: overrides.catalogUnit ?? 'm',
    catalogUnitsPerSourceUnit: overrides.catalogUnitsPerSourceUnit ?? '6',
    scope,
    version: overrides.version ?? 1,
    approvedBy: overrides.approvedBy ?? 'admin',
    approvedAt: overrides.approvedAt ?? '2026-08-01T00:00:00.000Z',
  }
  if (overrides.catalogId !== undefined) {
    rule.catalogId = overrides.catalogId
  } else if (scope === 'catalog_item') {
    rule.catalogId = 'pipe-100'
  }
  if (overrides.archivedAt !== undefined) {
    rule.archivedAt = overrides.archivedAt
  }
  return rule
}

test('applies an item-specific length-to-metre rule', () => {
  const result = normalizePricingWithRule({
    source: reviewerPricing({ unit: 'length', quantity: '6', materialRate: '6000', total: '36000' }),
    catalogId: 'pipe-100',
    catalogDescription: 'PVC Pipe 100 mm',
    catalogUnit: 'm',
    rule: conversionRule({ catalogId: 'pipe-100', sourceUnit: 'length', catalogUnit: 'm', catalogUnitsPerSourceUnit: '6' }),
    currencyScale: 2,
  })
  assert.equal(result.normalizedQuantity, '36')
  assert.equal(result.normalizedMaterialRate, '1000')
  assert.equal(result.normalizedTotal, '36000')
  assert.equal(result.ruleId, 'rule-length-m-1')
  assert.equal(result.catalogUnitsPerSourceUnit, '6')
  assert.equal(result.catalogId, 'pipe-100')
  assert.equal(result.catalogUnit, 'm')
})

test('applies a global conversion rule without catalog binding', () => {
  const result = normalizePricingWithRule({
    source: reviewerPricing({
      unit: 'ft',
      quantity: '10',
      materialRate: '3.28084',
      labourRate: '0',
      total: '32.8084',
    }),
    catalogId: 'any-catalog',
    catalogDescription: 'Generic length item',
    catalogUnit: 'm',
    rule: conversionRule({
      id: 'global-ft-m',
      scope: 'global',
      sourceUnit: 'ft',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '0.3048',
    }),
    currencyScale: 2,
  })
  assert.equal(result.normalizedQuantity, '3.048')
  assert.equal(result.ruleId, 'global-ft-m')
  assert.equal(result.catalogUnitsPerSourceUnit, '0.3048')
  const globalRule = conversionRule({
    id: 'global-ft-m',
    scope: 'global',
    sourceUnit: 'ft',
    catalogUnit: 'm',
    catalogUnitsPerSourceUnit: '0.3048',
  })
  assert.equal('catalogId' in globalRule, false)
})

test('normalizes material and labour component rates independently and preserves total', () => {
  const result = normalizePricingWithRule({
    source: reviewerPricing({
      unit: 'length',
      quantity: '6',
      materialRate: '6000',
      labourRate: '3000',
      total: '54000',
    }),
    catalogId: 'pipe-100',
    catalogDescription: 'PVC Pipe 100 mm',
    catalogUnit: 'm',
    rule: conversionRule({
      catalogId: 'pipe-100',
      catalogUnitsPerSourceUnit: '6',
    }),
    currencyScale: 2,
  })
  assert.equal(result.normalizedQuantity, '36')
  assert.equal(result.normalizedMaterialRate, '1000')
  assert.equal(result.normalizedLabourRate, '500')
  assert.equal(result.normalizedTotal, '54000')
})

test('identityConversionRule uses stable system id and factor 1', () => {
  const rule = identityConversionRule('m')
  assert.equal(rule.scope, 'identity')
  assert.equal(rule.version, IDENTITY_CONVERSION_RULE_VERSION)
  assert.equal(rule.version, 1)
  assert.equal(rule.catalogUnitsPerSourceUnit, '1')
  assert.equal(rule.sourceUnit, 'm')
  assert.equal(rule.catalogUnit, 'm')
  assert.equal(rule.id, 'identity:m:v1')
})

test('identity normalization persists identity rule id without requiring a stored document', () => {
  const result = normalizePricingWithRule({
    source: reviewerPricing({
      unit: 'm',
      quantity: '12.5',
      materialRate: '40',
      labourRate: '10',
      total: '625',
    }),
    catalogId: 'rebar-10',
    catalogDescription: 'Rebar 10 mm',
    catalogUnit: 'm',
    rule: identityConversionRule('m'),
    currencyScale: 2,
  })
  assert.equal(result.ruleId, 'identity:m:v1')
  assert.equal(result.catalogUnitsPerSourceUnit, '1')
  assert.equal(result.normalizedQuantity, '12.5')
  assert.equal(result.normalizedMaterialRate, '40')
  assert.equal(result.normalizedLabourRate, '10')
  assert.equal(result.normalizedTotal, '625')
})

test('rejects archived human rules', () => {
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing(),
      catalogId: 'pipe-100',
      catalogDescription: 'PVC Pipe 100 mm',
      catalogUnit: 'm',
      rule: conversionRule({
        catalogId: 'pipe-100',
        archivedAt: '2026-08-02T00:00:00.000Z',
      }),
      currencyScale: 2,
    }),
    /archiv/i,
  )
})

test('rejects catalog-item rules for the wrong catalog id', () => {
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing(),
      catalogId: 'other-item',
      catalogDescription: 'Other',
      catalogUnit: 'm',
      rule: conversionRule({ catalogId: 'pipe-100' }),
      currencyScale: 2,
    }),
    /catalog/i,
  )
})

test('rejects zero and negative conversion factors', () => {
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing(),
      catalogId: 'pipe-100',
      catalogDescription: 'PVC Pipe 100 mm',
      catalogUnit: 'm',
      rule: conversionRule({ catalogId: 'pipe-100', catalogUnitsPerSourceUnit: '0' }),
      currencyScale: 2,
    }),
    /factor|positive|zero/i,
  )
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing(),
      catalogId: 'pipe-100',
      catalogDescription: 'PVC Pipe 100 mm',
      catalogUnit: 'm',
      rule: conversionRule({ catalogId: 'pipe-100', catalogUnitsPerSourceUnit: '-2' }),
      currencyScale: 2,
    }),
    /factor|positive/i,
  )
})

test('rejects identity rules when units are not canonically equal', () => {
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing({ unit: 'length' }),
      catalogId: 'pipe-100',
      catalogDescription: 'PVC Pipe 100 mm',
      catalogUnit: 'm',
      rule: identityConversionRule('m'),
      currencyScale: 2,
    }),
    /identity|unit/i,
  )
})

test('rejects mismatched source or catalog units against the rule', () => {
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing({ unit: 'bag' }),
      catalogId: 'pipe-100',
      catalogDescription: 'PVC Pipe 100 mm',
      catalogUnit: 'm',
      rule: conversionRule({ catalogId: 'pipe-100', sourceUnit: 'length', catalogUnit: 'm' }),
      currencyScale: 2,
    }),
    /unit/i,
  )
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing({ unit: 'length' }),
      catalogId: 'pipe-100',
      catalogDescription: 'PVC Pipe 100 mm',
      catalogUnit: 'kg',
      rule: conversionRule({ catalogId: 'pipe-100', sourceUnit: 'length', catalogUnit: 'm' }),
      currencyScale: 2,
    }),
    /unit/i,
  )
})

test('rejects normalization when totals disagree at currency minor units', () => {
  assert.throws(
    () => normalizePricingWithRule({
      source: reviewerPricing({
        quantity: '6',
        materialRate: '6000',
        labourRate: '0',
        // Intentionally inconsistent with qty × rates.
        total: '1',
      }),
      catalogId: 'pipe-100',
      catalogDescription: 'PVC Pipe 100 mm',
      catalogUnit: 'm',
      rule: conversionRule({ catalogId: 'pipe-100', catalogUnitsPerSourceUnit: '6' }),
      currencyScale: 2,
    }),
    /total|minor|currency/i,
  )
})
