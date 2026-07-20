import assert from 'node:assert/strict'
import test from 'node:test'
import {
  qualifyingLocalSuggestions,
  suggestionFromLlmResponse,
} from './inline-catalog-suggestion'
import type { BoqPricedItem } from './boq-schema'
import type { StandardEntry } from './standard-schema'

function standard(overrides: Partial<StandardEntry> & Pick<StandardEntry, 'id' | 'description' | 'unit'>): StandardEntry {
  return {
    aliases: [],
    sourceBoqCount: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function item(overrides: Partial<Pick<BoqPricedItem, 'desc' | 'unit' | 'stdStatus' | 'stdId'>> = {}) {
  return {
    desc: 'Ready-mix concrete C30',
    unit: 'm3',
    stdStatus: 'unmatched' as const,
    ...overrides,
  }
}

test('qualifies exact and alias matches only when their units are compatible', () => {
  const standards = [
    standard({ id: 'exact', description: 'Ready-mix concrete C30', unit: 'm³' }),
    standard({ id: 'alias', description: 'Ready-mix concrete', unit: 'm³', aliases: ['C30 concrete'] }),
    standard({ id: 'wrong-unit', description: 'Ready-mix concrete C30', unit: 'ton' }),
  ]

  const exactSuggestions = qualifyingLocalSuggestions(item(), standards, { m3: 'm³' })
  assert.deepEqual(exactSuggestions[0], {
    standardId: 'exact',
    description: 'Ready-mix concrete C30',
    unit: 'm³',
    source: 'local',
    confidence: 'exact',
    reason: 'Exact',
  })
  assert.equal(exactSuggestions.some((suggestion) => suggestion.standardId === 'wrong-unit'), false)

  const aliasSuggestions = qualifyingLocalSuggestions(item({ desc: 'C30 concrete' }), standards, { m3: 'm³' })
  assert.deepEqual(aliasSuggestions[0], {
    standardId: 'alias',
    description: 'Ready-mix concrete',
    unit: 'm³',
    source: 'local',
    confidence: 'exact',
    reason: 'Alias',
  })
  assert.equal(aliasSuggestions.some((suggestion) => suggestion.standardId === 'wrong-unit'), false)
})

test('qualifies only compatible fuzzy matches at the safe score threshold', () => {
  const standards = [
    standard({ id: 'safe', description: 'Structural concrete C30 columns', unit: 'm3' }),
    standard({ id: 'low-overlap', description: 'Concrete', unit: 'm3' }),
    standard({ id: 'wrong-unit', description: 'Structural concrete C30 columns', unit: 'ton' }),
  ]

  assert.deepEqual(
    qualifyingLocalSuggestions(item({ desc: 'Structural concrete C30 slab' }), standards, {}),
    [
      {
        standardId: 'safe',
        description: 'Structural concrete C30 columns',
        unit: 'm3',
        source: 'local',
        confidence: 'fuzzy',
        reason: 'Similar',
      },
    ],
  )
})

test('skips dismissed candidates and returns the next qualifying suggestion', () => {
  const standards = [
    standard({ id: 'first', description: 'Ready-mix concrete C30', unit: 'm3' }),
    standard({ id: 'second', description: 'Ready-mix concrete C30', unit: 'm3' }),
  ]

  assert.deepEqual(
    qualifyingLocalSuggestions(item(), standards, {}, new Set(['first'])),
    [
      {
        standardId: 'second',
        description: 'Ready-mix concrete C30',
        unit: 'm3',
        source: 'local',
        confidence: 'exact',
        reason: 'Exact',
      },
    ],
  )
})

test('does not suggest local matches for matched or excluded rows', () => {
  const standards = [standard({ id: 'std-1', description: 'Ready-mix concrete C30', unit: 'm3' })]

  assert.deepEqual(qualifyingLocalSuggestions(item({ stdStatus: 'matched', stdId: 'std-1' }), standards, {}), [])
  assert.deepEqual(qualifyingLocalSuggestions(item({ stdStatus: 'excluded' }), standards, {}), [])
})

test('accepts an LLM suggestion only for the expected key and an active catalog ID', () => {
  const standards = [standard({ id: 'std-1', description: 'Ready-mix concrete C30', unit: 'm3' })]

  assert.deepEqual(
    suggestionFromLlmResponse({
      suggestions: [{ key: '0:row-1', standardId: 'std-1', reason: 'Close catalog match' }],
    }, standards, '0:row-1'),
    {
      standardId: 'std-1',
      description: 'Ready-mix concrete C30',
      unit: 'm3',
      source: 'llm',
      confidence: 'llm',
      reason: 'AI suggestion',
    },
  )
})

test('rejects malformed, wrong-key, unknown, and archived LLM suggestions', () => {
  const standards = [
    standard({ id: 'active', description: 'Active item', unit: 'm3' }),
    standard({ id: 'archived', description: 'Archived item', unit: 'm3', archivedAt: '2025-01-01' }),
  ]
  const invalidResponses: unknown[] = [
    null,
    {},
    { suggestions: 'not an array' },
    { suggestions: [{}] },
    { suggestions: [{ key: 'wrong', standardId: 'active' }] },
    { suggestions: [{ key: 'row', standardId: 'unknown' }] },
    { suggestions: [{ key: 'row', standardId: 'archived' }] },
  ]

  for (const response of invalidResponses) {
    assert.equal(suggestionFromLlmResponse(response, standards, 'row'), null)
  }
})
