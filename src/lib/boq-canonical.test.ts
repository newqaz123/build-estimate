import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { parseCanonicalBoqSections } from './boq-canonical'

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
  assert.match(putSource, /parseCanonicalBoqSections\(hasSections \? body\.sections : existing\.sections\)/)
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
