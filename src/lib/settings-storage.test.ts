import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeNormalizeRules } from './settings-storage'

const defaults: [string, string][] = [['default', 'replacement']]

test('decodes legacy tuples and stored rule records while filtering malformed entries', () => {
  assert.deepEqual(
    decodeNormalizeRules([
      ['legacy', 'tuple'],
      { find: 'stored', replace: 'record' },
      ['missing replacement'],
      { find: 'missing replacement' },
      null,
    ], defaults),
    [
      ['legacy', 'tuple'],
      ['stored', 'record'],
    ],
  )
})

test('uses safe defaults when storage contains no valid rules', () => {
  assert.deepEqual(decodeNormalizeRules([null, ['bad']], defaults), defaults)
  const decoded = decodeNormalizeRules(undefined, defaults)
  assert.deepEqual(decoded, defaults)

  decoded[0][0] = 'mutated'
  assert.deepEqual(defaults, [['default', 'replacement']])
})

test('preserves an intentionally empty stored rules list', () => {
  assert.deepEqual(decodeNormalizeRules([], defaults), [])
})
