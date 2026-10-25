import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from './boq-schema'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import type { StandardEntry } from './standard-schema'
import { createRateConverter, convertRate } from './catalog-rate-conversion'
import { buildCatalogHistoricalPricing } from './catalog-historical-pricing'
import { compareBoqToCatalog } from './boq-catalog-comparison'

const now = '2026-10-25T00:00:00.000Z'
const pipe: StandardEntry = {
  id: 'pipe', description: 'Steel pipe 1 inch', unit: 'm', aliases: [], sourceBoqCount: 1, createdAt: now, updatedAt: now,
}

function rule(over: Partial<HumanApprovedCatalogConversionRule>): HumanApprovedCatalogConversionRule {
  return {
    id: 'r-global', sourceUnit: 'เส้น', catalogUnit: 'm', catalogUnitsPerSourceUnit: '4', scope: 'global',
    version: 1, approvedBy: 'u', approvedAt: now, ...over,
  } as HumanApprovedCatalogConversionRule
}

function quote(id: string, unit: string, rate: number): Boq {
  return {
    id, project: id, vendor: id, workType: 'Structural', date: '2026-10-01', totalItems: 1, grandTotal: rate,
    status: 'approved', stdStatus: 'complete', createdAt: now, updatedAt: now,
    sections: [{ header: 'Work', items: [{
      id: `${id}-1`, desc: 'Steel pipe 1 inch', unit, qty: 1, rate, total: rate, type: 'unit',
      stdStatus: 'matched', stdId: 'pipe',
    }] }],
  } as Boq
}

test('a global rule turns a per-เส้น price into a per-m price', () => {
  const convert = createRateConverter([rule({})])
  const conversion = convert('เส้น', pipe)
  assert.ok(conversion)
  assert.equal(conversion.catalogUnitsPerSourceUnit, 4)
  assert.equal(convertRate(400, conversion), 100)
  assert.equal(convert('m', pipe), null, 'same unit needs no rule')
  assert.equal(convert('kg', pipe), null, 'no rule, no conversion')
})

test('a rule for one catalog item wins over the general rule; archived rules are ignored; reversed rules work', () => {
  const rules = [
    rule({ id: 'a-global' }),
    rule({ id: 'b-item', scope: 'catalog_item', catalogId: 'pipe', catalogUnitsPerSourceUnit: '6' }),
    rule({ id: 'c-old', scope: 'catalog_item', catalogId: 'pipe', catalogUnitsPerSourceUnit: '10', archivedAt: now }),
  ]
  assert.equal(createRateConverter(rules)('เส้น', pipe)?.ruleId, 'b-item')
  assert.equal(createRateConverter(rules)('เส้น', { ...pipe, id: 'other' })?.ruleId, 'a-global')
  const reversed = createRateConverter([rule({ sourceUnit: 'm', catalogUnit: 'เส้น', catalogUnitsPerSourceUnit: '0.25' })])('เส้น', pipe)
  assert.equal(reversed?.catalogUnitsPerSourceUnit, 4)
})

test('price history counts quotes in another unit once a rule converts them', () => {
  const boqs = [quote('q1', 'm', 110), quote('q2', 'เส้น', 360)]
  assert.equal(buildCatalogHistoricalPricing([pipe], boqs).get('pipe')?.count, 1, 'without a rule the เส้น quote is left out')
  const pricing = buildCatalogHistoricalPricing([pipe], boqs, {}, { conversionRules: [rule({})] }).get('pipe')
  assert.equal(pricing?.count, 2)
  assert.equal(pricing?.average, 100)
  const converted = pricing?.sources.find((source) => source.boqId === 'q2')
  assert.deepEqual(converted?.converted, { unit: 'เส้น', rate: 360, ruleId: 'r-global', catalogUnitsPerSourceUnit: 4 })
  assert.equal(converted?.unit, 'm')
})

test('compare converts the quoted rate before working out the difference', () => {
  const target = quote('target', 'เส้น', 480)
  const boqs = [target, quote('q1', 'm', 100)]
  const withRule = compareBoqToCatalog(target, [pipe], boqs, {}, [rule({})]).rows[0]
  assert.equal(withRule?.conversion?.catalogRate, 120)
  assert.equal(withRule?.variancePct, 20)
  const withoutRule = compareBoqToCatalog(target, [pipe], boqs).rows[0]
  assert.equal(withoutRule?.variancePct, null, 'different units with no rule cannot be compared')
})
