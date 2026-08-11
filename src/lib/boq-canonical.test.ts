import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { parseCanonicalBoqSections } from './boq-canonical'
import type { BoqPricedItem } from './boq-schema'

const priced = {
  id: 'parent', desc: 'Pump package', unit: 'item', qty: 1, rate: 95_200, total: 95_200,
  type: 'unit', stdStatus: 'matched',
}

test('POST canonical parsing accepts legacy priced rows and valid excluded options', () => {
  const sections = parseCanonicalBoqSections([{ header: 'Pump', items: [
    priced,
    { ...priced, id: 'option', optional: true, excludedFromTotal: true, exclusionReason: 'Client alternate' },
  ] }])
  assert.equal(sections[0].items[0].pricingRole, undefined)
  assert.equal(sections[0].items[1].excludedFromTotal, true)
})

test('canonical parsing rejects malformed children, flags, exclusions, and parent references', () => {
  const invalid = [
    [{ header: 'Pump', items: [{ id: 'child', pricingRole: 'bundle_child', parentBundleId: 'parent', desc: 'Body', stdStatus: 'pending', total: 0 }] }],
    [{ header: 'Pump', items: [{ ...priced, optional: 'yes' }] }],
    [{ header: 'Pump', items: [{ ...priced, excludedFromTotal: true, optional: false, exclusionReason: 'No' }] }],
    [{ header: 'Pump', items: [{ ...priced, id: 'child', pricingRole: 'bundle_child', parentBundleId: 'missing', desc: 'Body', stdStatus: 'pending' }] }],
  ]
  for (const sections of invalid) assert.throws(() => parseCanonicalBoqSections(sections), /section|item|optional|excluded|parent/i)
})

test('canonical parsing accepts a valid parent and informational child', () => {
  const sections = parseCanonicalBoqSections([{ header: 'Pump', items: [
    { ...priced, pricingRole: 'bundle_parent' },
    { id: 'child', pricingRole: 'bundle_child', parentBundleId: 'parent', desc: 'Pump body', stdStatus: 'pending' },
  ] }])
  assert.equal(sections[0].items[1].pricingRole, 'bundle_child')
})

test('canonical parsing rejects invalid item and nested enum values', () => {
  const invalid = [
    { ...priced, entryOrigin: 'spreadsheet' },
    { ...priced, stdConfidence: 'guess' },
    { ...priced, costComponent: 'equipment' },
    { ...priced, costAllocation: { basis: 'quantity', material: 1, labour: 2, origin: 'source' } },
  ]
  for (const item of invalid) {
    assert.throws(() => parseCanonicalBoqSections([{ header: 'Pump', items: [item] }]), /invalid/)
  }
})

test('POST and PUT BOQ boundaries both invoke canonical section parsing', () => {
  const postSource = readFileSync(new URL('../app/api/boqs/route.ts', import.meta.url), 'utf8')
  const putSource = readFileSync(new URL('../app/api/boqs/[id]/handler.ts', import.meta.url), 'utf8')
  assert.match(postSource, /parseCanonicalBoqSections\(sections \?\? \[\]\)/)
  assert.match(putSource, /hasSections \? parseCanonicalBoqSections\(body\.sections\) : undefined/)
  assert.match(putSource, /requestSections \?\? parseCanonicalBoqSections\(current\.sections\)/)
  assert.match(postSource, /BoqCanonicalValidationError/)
  assert.match(putSource, /BoqCanonicalValidationError/)
})

test('bundle children reject malformed warnings and every priced-only field', () => {
  const parent = { ...priced, pricingRole: 'bundle_parent' }
  for (const extension of [
    { extractionWarnings: 'not-an-array' },
    { costComponent: 'material' },
    { sourceCosts: { material: {}, labour: {} } },
    { costAllocation: { basis: 'rate', material: 1, labour: 2, origin: 'manual' } },
  ]) {
    assert.throws(() => parseCanonicalBoqSections([{ header: 'Pump', items: [
      parent,
      { id: 'child', pricingRole: 'bundle_child', parentBundleId: 'parent', desc: 'Body', stdStatus: 'pending', ...extension },
    ] }]), /bundle child|extractionWarnings/i)
  }
})

test('valid common provenance and structured warnings survive canonical parsing while unknown keys are stripped', () => {
  const parsed = parseCanonicalBoqSections([{ header: 'Pump', unsafeSectionKey: '<script>', items: [{
    ...priced,
    sourceRef: { page: 2, table: 1, row: 4, unsafe: true },
    sourceRowId: 'row-4',
    sourceRowIds: ['row-4', 'row-5'],
    entryOrigin: 'docling',
    extractionWarnings: [{ code: 'merged_row', message: 'Confirm grouping', sourceRef: { page: 2, table: 1, row: 4 }, unsafe: true }],
    stdConfidence: 'exact',
    sourceDesc: 'Original pump',
    sourceUnit: 'item',
    unsafeItemKey: '<script>',
  }] }])
  const section = parsed[0] as unknown as Record<string, unknown>
  const item = parsed[0].items[0] as unknown as Record<string, unknown>
  assert.equal('unsafeSectionKey' in section, false)
  assert.equal('unsafeItemKey' in item, false)
  assert.deepEqual(item.sourceRef, { page: 2, table: 1, row: 4 })
  assert.deepEqual(item.extractionWarnings, [{ code: 'merged_row', message: 'Confirm grouping', sourceRef: { page: 2, table: 1, row: 4 } }])
  assert.deepEqual(item.sourceRowIds, ['row-4', 'row-5'])
})

const extractedPricing = {
  description: 'Pump package', unit: 'item', quantity: '1',
  materialRate: '57120', labourRate: '38080', total: '95200',
}
const reviewerPricing = {
  description: 'Pump package', unit: 'item', quantity: '1',
  materialRate: '57120', labourRate: '38080', total: '95200',
  confirmedAt: '2026-08-08T00:00:00.000Z', confirmedBy: 'reviewer-1',
}
const pricingNormalization = {
  catalogId: 'STD-PUMP', catalogDescription: 'Pump package', catalogUnit: 'item',
  ruleId: 'identity', catalogUnitsPerSourceUnit: '1',
  normalizedQuantity: '1', normalizedMaterialRate: '57120',
  normalizedLabourRate: '38080', normalizedTotal: '95200',
}
const convertedItem = {
  ...priced, stdId: 'STD-PUMP', extractedPricing, reviewerPricing, pricingNormalization,
}

test('converted items round-trip immutable extracted, reviewer, and normalization snapshots', () => {
  const parsed = parseCanonicalBoqSections([{ header: 'Pump', items: [convertedItem] }])
  const item = parsed[0].items[0] as BoqPricedItem
  assert.deepEqual(item.extractedPricing, extractedPricing)
  assert.deepEqual(item.reviewerPricing, reviewerPricing)
  assert.deepEqual(item.pricingNormalization, pricingNormalization)
})

test('legacy items without snapshots still canonicalize with no backfill', () => {
  const parsed = parseCanonicalBoqSections([{ header: 'Pump', items: [priced] }])
  const item = parsed[0].items[0] as BoqPricedItem
  assert.equal(item.extractedPricing, undefined)
  assert.equal(item.reviewerPricing, undefined)
  assert.equal(item.pricingNormalization, undefined)
})

test('converted items require all three pricing snapshots together', () => {
  for (const partial of [
    { extractedPricing },
    { reviewerPricing },
    { pricingNormalization },
    { extractedPricing, reviewerPricing },
    { reviewerPricing, pricingNormalization },
  ]) {
    assert.throws(
      () => parseCanonicalBoqSections([{ header: 'Pump', items: [{ ...priced, stdId: 'STD-PUMP', ...partial }] }]),
      /together/i,
    )
  }
})

test('reviewer edits never overwrite extracted pricing and divergence needs a correction reason', () => {
  const divergentReviewer = {
    ...reviewerPricing,
    labourRate: '38880',
    total: '96000',
    correctionReason: 'Adjusted labour allocation per vendor call',
  }
  const divergentNormalization = { ...pricingNormalization, normalizedLabourRate: '38880', normalizedTotal: '96000' }
  const parsed = parseCanonicalBoqSections([{ header: 'Pump', items: [
    { ...priced, stdId: 'STD-PUMP', total: 96_000, extractedPricing, reviewerPricing: divergentReviewer, pricingNormalization: divergentNormalization },
  ] }])
  const item = parsed[0].items[0] as BoqPricedItem
  assert.equal(item.extractedPricing?.total, '95200')
  assert.equal(item.reviewerPricing?.total, '96000')
  assert.equal(item.reviewerPricing?.correctionReason, 'Adjusted labour allocation per vendor call')

  assert.throws(
    () => parseCanonicalBoqSections([{ header: 'Pump', items: [
      { ...priced, stdId: 'STD-PUMP', total: 96_000, extractedPricing, reviewerPricing: { ...divergentReviewer, correctionReason: undefined }, pricingNormalization: divergentNormalization },
    ] }]),
    /correctionReason|divergence/i,
  )
})

test('normalization catalog id, unit, and total must match the linked priced item', () => {
  assert.throws(
    () => parseCanonicalBoqSections([{ header: 'Pump', items: [{ ...convertedItem, stdId: 'WRONG' }] }]),
    /catalogId.*stdId/i,
  )
  assert.throws(
    () => parseCanonicalBoqSections([{ header: 'Pump', items: [{ ...convertedItem, unit: 'ft3' }] }]),
    /catalogUnit.*unit/i,
  )
  assert.throws(
    () => parseCanonicalBoqSections([{ header: 'Pump', items: [{ ...convertedItem, total: 99_999 }] }]),
    /normalizedTotal.*total/i,
  )
})

test('reviewer-confirmed total must match the normalized total at currency minor-unit precision', () => {
  assert.throws(
    () => parseCanonicalBoqSections([{ header: 'Pump', items: [
      { ...priced, stdId: 'STD-PUMP', total: 96_000, extractedPricing,
        reviewerPricing: { ...reviewerPricing, total: '95200', correctionReason: 'Labour reallocation' },
        pricingNormalization: { ...pricingNormalization, normalizedLabourRate: '38880', normalizedTotal: '96000' } },
    ] }]),
    /reviewerPricing\.total.*normalized/i,
  )
})

test('source costs accept an absent v2 component with an empty unit but not a present one', () => {
  const costs = {
    material: { present: true, qty: 1, unit: 'item', rate: 10, total: 10 },
    labour: { present: false, qty: 0, unit: '', rate: 0, total: 0 },
  }
  const parsed = parseCanonicalBoqSections([{ header: 'Pump', items: [{ ...priced, sourceCosts: costs }] }])
  assert.deepEqual((parsed[0].items[0] as { sourceCosts?: unknown }).sourceCosts, costs)
  assert.throws(() => parseCanonicalBoqSections([{ header: 'Pump', items: [{
    ...priced,
    sourceCosts: { ...costs, labour: { ...costs.labour, present: true } },
  }] }]), /sourceCosts\.labour\.unit/)
})
