import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCatalogAiSuggestion } from './catalog-ai'

const standards = [
  {
    id: 'std-concrete',
    description: 'Ready-mix concrete C32/40',
    unit: 'm³',
    aliases: ['C32 concrete'],
    sourceBoqCount: 1,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  },
]

test('resolves an AI suggestion only when its ID belongs to the loaded catalog', () => {
  const result = resolveCatalogAiSuggestion(
    { content: JSON.stringify([{ matchedStdId: 'std-concrete', reason: 'Same grade and unit' }]) },
    standards,
  )

  assert.equal(result.candidate?.id, 'std-concrete')
  assert.equal(result.reason, 'Same grade and unit')
})

test('does not invent a catalog ID from an unknown AI suggestion', () => {
  const result = resolveCatalogAiSuggestion(
    { content: JSON.stringify([{ matchedStdId: 'std-made-up', stdDescription: 'New item' }]) },
    standards,
  )

  assert.equal(result.candidate, null)
  assert.match(result.reason ?? '', /could not be verified/i)
})

test('does not accept a description match when the AI response has no valid catalog ID', () => {
  const result = resolveCatalogAiSuggestion(
    { content: JSON.stringify([{ stdDescription: 'Ready-mix concrete C32/40', reason: 'Same description' }]) },
    standards,
  )

  assert.equal(result.candidate, null)
  assert.match(result.reason, /could not be verified/i)
})
