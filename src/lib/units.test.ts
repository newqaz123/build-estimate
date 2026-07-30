import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CUSTOM_UNITS,
  STANDARD_UNITS,
  WorkspaceUnitError,
  combineUnitOptions,
  filterUnits,
  mergeWorkspaceUnit,
  normalizeNewUnit,
  normalizeWorkspaceUnit,
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
