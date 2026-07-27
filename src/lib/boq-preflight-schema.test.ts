import assert from 'node:assert/strict'
import test from 'node:test'
import { parseConfirmedPageSelection } from './boq-preflight-schema'

test('normalizes confirmed pages into sorted unique page numbers', () => {
  assert.deepEqual(parseConfirmedPageSelection({ pages: [3, 1, 3] }, 4), { pages: [1, 3] })
})

test('rejects an empty page selection', () => {
  assert.throws(() => parseConfirmedPageSelection({ pages: [] }, 4), /at least one/)
})

test('rejects unknown keys and invalid page values', () => {
  assert.throws(() => parseConfirmedPageSelection({ pages: [1], extra: true }, 4), /unknown/i)
  assert.throws(() => parseConfirmedPageSelection({ pages: [0] }, 4), /1 and 4/)
  assert.throws(() => parseConfirmedPageSelection({ pages: [5] }, 4), /1 and 4/)
  assert.throws(() => parseConfirmedPageSelection({ pages: [1.5] }, 4), /integer/)
  assert.throws(() => parseConfirmedPageSelection(null, 4), /object/)
})
