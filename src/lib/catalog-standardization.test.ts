import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCatalogStandardizationPrompt,
  normalizeCatalogStandardizationResponse,
  parseCatalogStandardizationRequest,
} from './catalog-standardization'
import type { StandardEntry } from './standard-schema'

const standards: StandardEntry[] = [
  { id: 'std-1', description: 'Ready-mix concrete', unit: 'm3', aliases: [], sourceBoqCount: 0, createdAt: '', updatedAt: '' },
]

test('parses a bounded structured standardization request', () => {
  const parsed = parseCatalogStandardizationRequest({
    items: [{ key: '0:item-1', description: 'Concrete C30', unit: 'm3' }],
  })

  assert.deepEqual(parsed, {
    items: [{ key: '0:item-1', description: 'Concrete C30', unit: 'm3' }],
  })
  assert.throws(() => parseCatalogStandardizationRequest({ messages: [] }), /items/i)
  assert.throws(() => parseCatalogStandardizationRequest({ items: Array.from({ length: 101 }, (_, index) => ({ key: String(index), description: 'x', unit: 'm' })) }), /100/i)
})

test('prompt constrains suggestions to supplied catalog IDs', () => {
  const prompt = buildCatalogStandardizationPrompt(
    { items: [{ key: 'row-1', description: 'Concrete', unit: 'm3' }] },
    standards,
  )

  assert.match(prompt, /std-1/)
  assert.match(prompt, /never invent/i)
  assert.match(prompt, /row-1/)
})

test('normalization accepts only known IDs and requested item keys', () => {
  const result = normalizeCatalogStandardizationResponse(JSON.stringify([
    { key: 'row-1', standardId: 'std-1', reason: 'Equivalent concrete' },
    { key: 'row-1', standardId: 'invented', reason: 'Bad' },
    { key: 'not-requested', standardId: 'std-1', reason: 'Bad' },
  ]), { items: [{ key: 'row-1', description: 'Concrete', unit: 'm3' }] }, standards)

  assert.deepEqual(result, [{
    key: 'row-1',
    standardId: 'std-1',
    description: 'Ready-mix concrete',
    unit: 'm3',
    reason: 'Equivalent concrete',
  }])
})

test('normalization safely returns no suggestions for invalid model output', () => {
  assert.deepEqual(normalizeCatalogStandardizationResponse('not json', { items: [] }, standards), [])
})
