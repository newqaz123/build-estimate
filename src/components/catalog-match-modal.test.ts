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

test('catalog matching closes only after the caller reload promise resolves', () => {
  for (const sectionStart of ['const handleApply', 'const handleCreateNew']) {
    const start = source.indexOf(sectionStart)
    const end = source.indexOf('\n  }', start)
    assert.ok(start >= 0 && end > start)
    const section = source.slice(start, end)
    const matchIndex = section.indexOf('await onMatch')
    const closeIndex = section.indexOf('setOpen(false)')
    const catchIndex = section.indexOf('catch (')

    assert.ok(matchIndex >= 0, `${sectionStart} must await onMatch`)
    assert.ok(closeIndex > matchIndex, `${sectionStart} must close only after onMatch resolves`)
    assert.ok(catchIndex > closeIndex, `${sectionStart} must retain the modal when onMatch rejects`)
  }
})
