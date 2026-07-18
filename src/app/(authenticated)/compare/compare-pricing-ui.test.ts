import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('compare explains empty historical pricing instead of showing ambiguous dashes', () => {
  assert.match(source, /No prior approved history/)
  assert.match(source, /Not enough history to compare/)
  assert.match(source, /Approved historical average/)
  assert.match(source, /Compared with average/)
})
