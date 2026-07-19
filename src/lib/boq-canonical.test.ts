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
  assert.match(putSource, /parseCanonicalBoqSections\(body\.sections\)/)
  assert.match(postSource, /BoqCanonicalValidationError/)
  assert.match(putSource, /BoqCanonicalValidationError/)
})
