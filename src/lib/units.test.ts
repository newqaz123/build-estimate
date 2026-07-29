import assert from 'node:assert/strict'
import test from 'node:test'
import { STANDARD_UNITS, filterUnits, normalizeNewUnit } from './units'

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
