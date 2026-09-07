import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  descSuggestionNotice,
  normalizeEstimateItems,
  shouldSearchDescSuggestions,
  toEstimateItemPayload,
} from './page'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('estimate item normalization and save payload preserve catalog stdId', () => {
  const [item] = normalizeEstimateItems([
    {
      code: 'A-1',
      desc: 'Ready-mix concrete',
      unit: 'm³',
      qty: 2,
      rate: 100,
      total: 200,
      source: 'imported',
      stdId: 'std-1',
      stdSnapshot: { description: 'Ready-mix concrete', unit: 'm³' },
    },
  ])

  assert.equal(item?.stdId, 'std-1')
  assert.deepEqual(item?.stdSnapshot, { description: 'Ready-mix concrete', unit: 'm³' })
  assert.equal(toEstimateItemPayload(item!).stdId, 'std-1')
  assert.deepEqual(toEstimateItemPayload(item!).stdSnapshot, { description: 'Ready-mix concrete', unit: 'm³' })
})

test('catalog picker explains historical average seeding and no-history fallback', () => {
  assert.match(source, /Approved average/)
  assert.match(source, /No approved history · rate starts at ฿0/)
  assert.match(source, /standardEntryToEstimateAiCatalogEntry/)
  assert.match(source, /setModalRate\(String\(h\.historicalPricing\?\.average \?\? 0\)\)/)
})

const picked = { id: 'std-1', description: 'Ready-mix concrete C30', unit: 'm³' }

test('new item dialog reports the picked catalog entry instead of "not found"', () => {
  // Selecting a suggestion sets desc to the standard description and clears the
  // suggestion list — the notice must confirm the selection, never "no match".
  assert.deepEqual(
    descSuggestionNotice({
      desc: picked.description,
      suggestions: 0,
      loading: false,
      selectedStandard: picked,
      searchedFor: 'ready',
    }),
    { kind: 'selected', description: 'Ready-mix concrete C30' },
  )

  // Post-selection must not re-run the catalog search (dropdown stays closed).
  assert.equal(
    shouldSearchDescSuggestions({ modalOpen: true, desc: picked.description, selectedStandard: picked }),
    false,
  )
})

test('new item dialog shows "searching" until a search completes for the current text', () => {
  // Fetch in flight.
  assert.deepEqual(
    descSuggestionNotice({ desc: 'concrete pump', suggestions: 0, loading: true, selectedStandard: null, searchedFor: 'conc' }),
    { kind: 'searching' },
  )
  // Debounce window (fetch not started for the current text).
  assert.deepEqual(
    descSuggestionNotice({ desc: 'concrete pump', suggestions: 0, loading: false, selectedStandard: null, searchedFor: 'conc' }),
    { kind: 'searching' },
  )
  // Completed search with zero results → genuine "no match".
  assert.deepEqual(
    descSuggestionNotice({ desc: 'zzz unknown item', suggestions: 0, loading: false, selectedStandard: null, searchedFor: 'zzz unknown item' }),
    { kind: 'no-match' },
  )
})

test('new item dialog hides the notice for empty text or visible suggestions', () => {
  assert.deepEqual(
    descSuggestionNotice({ desc: '   ', suggestions: 0, loading: false, selectedStandard: null, searchedFor: '' }),
    { kind: 'hidden' },
  )
  assert.deepEqual(
    descSuggestionNotice({ desc: 'concrete', suggestions: 3, loading: false, selectedStandard: null, searchedFor: 'concrete' }),
    { kind: 'hidden' },
  )
})

test('new item dialog search gating skips closed modal, short text, and re-enables after edits', () => {
  assert.equal(shouldSearchDescSuggestions({ modalOpen: false, desc: 'concrete', selectedStandard: null }), false)
  assert.equal(shouldSearchDescSuggestions({ modalOpen: true, desc: ' c ', selectedStandard: null }), false)
  assert.equal(shouldSearchDescSuggestions({ modalOpen: true, desc: 'concrete', selectedStandard: null }), true)
  // Editing away from a picked description re-enables the search.
  assert.equal(
    shouldSearchDescSuggestions({ modalOpen: true, desc: 'Ready-mix concrete C3', selectedStandard: picked }),
    true,
  )
})

test('new item dialog renders the suggestion notice through the shared helpers', () => {
  assert.match(source, /descSuggestionNotice\(\{/)
  assert.match(source, /shouldSearchDescSuggestions\(\{/)
  // The un-gated empty state was the "selected but shows not found" bug.
  assert.doesNotMatch(source, /modalDesc && descSuggestions\.length === 0/)
})
