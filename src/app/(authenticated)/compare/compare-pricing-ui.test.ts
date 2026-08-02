import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('compare renders component summary and delegates grouped rows', () => {
  assert.match(source, /Material rate vs catalog/)
  assert.match(source, /Labour rate vs catalog/)
  assert.match(source, /Lines with component data/)
  assert.match(source, /BOQ total/)
  assert.match(source, /BoqCatalogComponentTable/)
  assert.match(source, /onMatch=\{setMatchTarget\}/)
  assert.match(source, /Review, match & approve/)
})
