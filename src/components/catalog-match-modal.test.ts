import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./catalog-match-modal.tsx', import.meta.url), 'utf8')

test('catalog matching keeps one search control and switches the footer for create mode', () => {
  assert.equal((source.match(/data-od-id="catalog-match-search"/g) ?? []).length, 1)
  assert.doesNotMatch(source, /catalog-match-search-existing|Search existing items/)
  assert.match(source, /newItemOpen \? "Create and link item" : "Confirm match"/)
  assert.match(source, /newItemOpen \? "Back to matches" : "Cancel"/)
})
