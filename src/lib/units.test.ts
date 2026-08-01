import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CUSTOM_UNITS,
  STANDARD_UNITS,
  WorkspaceUnitError,
  combineUnitOptions,
  countUnitUsage,
  filterUnits,
  mapUnitUsage,
  mergeWorkspaceUnit,
  normalizeNewUnit,
  normalizeWorkspaceUnit,
  removeWorkspaceUnit,
  renameWorkspaceUnit,
} from './units'

test('STANDARD_UNITS includes the settings-documented construction units', () => {
  const units = STANDARD_UNITS as readonly string[]
  for (const expected of ['m³', 'm²', 'm', 'ton', 'ea', 'set', 'kg', 'LS']) {
    assert.ok(units.includes(expected), `missing unit: ${expected}`)
  }
})

test('filterUnits matches case-insensitively, de-duplicates, preserves order', () => {
  assert.deepEqual(filterUnits(['m³', 'm²', 'm', 'ton'], 'm'), ['m³', 'm²', 'm'])
  assert.deepEqual(filterUnits(['m', 'M', 'kg'], ''), ['m', 'kg'])
  assert.deepEqual(filterUnits(['ton', 'Ton'], 'to'), ['ton'])
})

test('normalizeNewUnit trims, rejects empty and case-insensitive duplicates', () => {
  assert.equal(normalizeNewUnit('  m³  ', ['m', 'kg']), 'm³')
  assert.equal(normalizeNewUnit('', ['m']), null)
  assert.equal(normalizeNewUnit('   ', ['m']), null)
  assert.equal(normalizeNewUnit('m', ['m³', 'M']), null)
})

test('workspace units trim, reject control characters, and enforce 24 characters', () => {
  assert.equal(normalizeWorkspaceUnit('  bag  '), 'bag')
  assert.throws(
    () => normalizeWorkspaceUnit('bad\u0000unit'),
    (error: unknown) => error instanceof WorkspaceUnitError && error.status === 400,
  )
  assert.throws(
    () => normalizeWorkspaceUnit('x'.repeat(25)),
    (error: unknown) => error instanceof WorkspaceUnitError && error.status === 400,
  )
})

test('workspace units preserve canonical casing and insertion order', () => {
  const first = mergeWorkspaceUnit([], 'Bag')
  const duplicate = mergeWorkspaceUnit(first.customUnits, ' bag ')
  const second = mergeWorkspaceUnit(duplicate.customUnits, 'drum')

  assert.deepEqual(second.customUnits, ['Bag', 'drum'])
  assert.deepEqual(duplicate, {
    unit: 'Bag',
    customUnits: ['Bag'],
    added: false,
  })
  assert.deepEqual(combineUnitOptions(['Bag', 'bag', 'm³']), [
    ...STANDARD_UNITS,
    'Bag',
  ])
})

test('a new unit beyond the 200-unit cap returns conflict but duplicates remain idempotent', () => {
  const full = Array.from({ length: MAX_CUSTOM_UNITS }, (_, index) => `u${index}`)
  assert.equal(mergeWorkspaceUnit(full, 'U0').added, false)
  assert.throws(
    () => mergeWorkspaceUnit(full, 'overflow'),
    (error: unknown) => error instanceof WorkspaceUnitError && error.status === 409,
  )
})

test('removeWorkspaceUnit drops a custom unit and throws when absent', () => {
  assert.deepEqual(removeWorkspaceUnit(['pallet', 'crate'], 'pallet'), ['crate'])
  assert.deepEqual(removeWorkspaceUnit(['pallet'], 'pallet'), [])
  // Case-sensitive match (canonical casing preserved elsewhere); absent -> 404.
  assert.throws(
    () => removeWorkspaceUnit(['pallet'], 'Pallet'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 404,
  )
  assert.throws(
    () => removeWorkspaceUnit([], 'pallet'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 404,
  )
})

test('renameWorkspaceUnit replaces a custom unit in place, validating the new value', () => {
  // In-place replacement preserves order at oldUnit's position.
  assert.deepEqual(
    renameWorkspaceUnit(['pallet', 'crate', 'bag'], 'crate', 'Crate').customUnits,
    ['pallet', 'Crate', 'bag'],
  )
  // newUnit is trimmed.
  assert.deepEqual(
    renameWorkspaceUnit(['pallet'], 'pallet', '  palletX  ').customUnits,
    ['palletX'],
  )
  // oldUnit absent -> 404.
  assert.throws(
    () => renameWorkspaceUnit(['pallet'], 'crate', 'box'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 404,
  )
  // newUnit empty -> 400.
  assert.throws(
    () => renameWorkspaceUnit(['pallet'], 'pallet', '   '),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 400,
  )
  // newUnit collides with another existing unit -> 400.
  assert.throws(
    () => renameWorkspaceUnit(['pallet', 'crate'], 'pallet', 'crate'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 400,
  )
  // newUnit over length -> 400.
  assert.throws(
    () => renameWorkspaceUnit(['pallet'], 'pallet', 'x'.repeat(25)),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 400,
  )
  // rename to the same canonical value is a no-op-style success (not a collision with self).
  assert.deepEqual(
    renameWorkspaceUnit(['pallet', 'crate'], 'pallet', 'pallet').customUnits,
    ['pallet', 'crate'],
  )
  // newUnit over the cap is still allowed (rename does not grow the list).
  const many = Array.from({ length: MAX_CUSTOM_UNITS }, (_, i) => `u${i}`)
  assert.deepEqual(
    renameWorkspaceUnit(many, 'u0', 'uZero').customUnits.length,
    MAX_CUSTOM_UNITS,
  )
})

test('mapUnitUsage counts priced items by unit and ignores bundle children', () => {
  const boqs = [
    {
      sections: [
        {
          items: [
            { pricingRole: 'standard', unit: 'm³' },
            { pricingRole: 'bundle_parent', unit: 'set' },
            { pricingRole: 'bundle_child', unit: 'kg' }, // ignored
            { unit: 'm³' }, // priced (no pricingRole) -> counted
          ],
        },
      ],
    },
  ] as unknown as Parameters<typeof mapUnitUsage>[0]
  assert.deepEqual(mapUnitUsage(boqs), { 'm³': 2, set: 1 })
})

test('countUnitUsage reads the map for a single unit', () => {
  const boqs = [
    { sections: [{ items: [{ pricingRole: 'standard', unit: 'ton' }, { unit: 'ton' }] }] },
  ] as unknown as Parameters<typeof countUnitUsage>[0]
  assert.equal(countUnitUsage(boqs, 'ton'), 2)
  assert.equal(countUnitUsage(boqs, 'absent'), 0)
})
