import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildEstimateAiUserMessage,
  catalogEntryToEstimateItem,
  buildEstimateAiManualFallback,
  filterCatalogContextToActiveEntries,
  normalizeEstimateAiResponse,
  resolveEstimateAiConfig,
  standardEntryToEstimateAiCatalogEntry,
  validateEstimateAiRequest,
  verifyEstimateAiSuggestion,
} from './estimate-ai'

const catalog = [
  {
    id: 'std-concrete',
    description: 'Ready-mix concrete C32/40',
    unit: 'm³',
    defaultQty: 1,
    defaultRate: 3850,
  },
]

test('validates the estimate chat request and rejects oversized or empty messages', () => {
  assert.equal(validateEstimateAiRequest({ message: '' }).ok, false)
  assert.equal(validateEstimateAiRequest({ message: 'x'.repeat(4001) }).ok, false)

  const result = validateEstimateAiRequest({
    message: 'Need concrete for a four-storey office',
    estimate: { projectName: 'Office', items: [] },
    catalog: { available: catalog, selected: [] },
  })

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.message, 'Need concrete for a four-storey office')
    assert.equal(result.value.catalog.available[0]?.id, 'std-concrete')
  }
})

test('serializes current estimate and catalog context with an ID allow-list instruction', () => {
  const result = validateEstimateAiRequest({
    message: 'Add concrete columns',
    estimate: {
      projectName: 'Office',
      items: [{ desc: 'Existing item', unit: 'm²', qty: 3, rate: 100 }],
    },
    catalog: { available: catalog, selected: catalog },
  })

  assert.equal(result.ok, true)
  if (!result.ok) return

  const prompt = buildEstimateAiUserMessage(result.value)
  assert.match(prompt, /Add concrete columns/)
  assert.match(prompt, /Existing item/)
  assert.match(prompt, /std-concrete/)
  assert.match(prompt, /only.*catalog context/i)
})

test('normalizes known catalog IDs to canonical snapshots and unknown IDs to manual items', () => {
  const result = normalizeEstimateAiResponse(JSON.stringify({
    message: 'I found one catalog match and one item to verify manually.',
    suggestions: [
      { stdId: 'std-concrete', description: 'AI paraphrase', unit: 'bag', quantity: 12, rate: 4000, reason: 'Concrete scope' },
      { stdId: 'invented-id', description: 'Temporary pump', unit: 'day', quantity: 2, rate: 9000 },
    ],
  }), catalog)

  assert.equal(result.assistantText, 'I found one catalog match and one item to verify manually.')
  assert.deepEqual(result.suggestions[0], {
    stdId: 'std-concrete',
    description: 'Ready-mix concrete C32/40',
    unit: 'm³',
    quantity: 12,
    rate: 4000,
    source: 'catalog',
    reason: 'Concrete scope',
  })
  assert.equal(result.suggestions[1]?.stdId, undefined)
  assert.equal(result.suggestions[1]?.source, 'manual')
})

test('creates a catalog snapshot row and verifies AI IDs against the supplied catalog', () => {
  const row = catalogEntryToEstimateItem(catalog[0], { quantity: 6, rate: 3900 })
  assert.deepEqual(row, {
    desc: 'Ready-mix concrete C32/40',
    unit: 'm³',
    qty: 6,
    rate: 3900,
    total: 23400,
    source: 'imported',
    stdId: 'std-concrete',
    stdSnapshot: { description: 'Ready-mix concrete C32/40', unit: 'm³' },
  })

  const verified = verifyEstimateAiSuggestion({
    stdId: 'std-concrete',
    description: 'AI wording',
    unit: 'bag',
    quantity: 2,
    rate: 100,
    source: 'catalog',
    reason: 'Matched',
  }, catalog)
  assert.equal(verified.description, 'Ready-mix concrete C32/40')
  assert.equal(verified.unit, 'm³')

  const manual = verifyEstimateAiSuggestion({
    stdId: 'not-supplied',
    description: 'Temporary pump',
    unit: 'day',
    quantity: 2,
    rate: 9000,
    source: 'catalog',
    reason: 'Unverified',
  }, catalog)
  assert.equal(manual.stdId, undefined)
  assert.equal(manual.source, 'manual')
})

test('uses each independent catalog item historical average as its editable estimate seed rate', () => {
  const pipe = standardEntryToEstimateAiCatalogEntry({
    id: 'std-pipe', description: 'Stainless pipe 6 inch', unit: 'pcs', aliases: [], sourceBoqCount: 2,
    createdAt: '2026-07-18', updatedAt: '2026-07-18',
    historicalPricing: { count: 2, min: 90, average: 100, max: 110, sources: [] },
  })
  const welding = standardEntryToEstimateAiCatalogEntry({
    id: 'std-weld', description: 'Welded pipe joint 6 inch', unit: 'DB', aliases: [], sourceBoqCount: 2,
    createdAt: '2026-07-18', updatedAt: '2026-07-18',
    historicalPricing: { count: 2, min: 180, average: 200, max: 220, sources: [] },
  })

  assert.equal(catalogEntryToEstimateItem(pipe).rate, 100)
  assert.equal(catalogEntryToEstimateItem(welding).rate, 200)
  assert.equal(catalogEntryToEstimateItem(pipe).unit, 'pcs')
  assert.equal(catalogEntryToEstimateItem(welding).unit, 'DB')
})

test('filters client catalog context to active server catalog entries and restores canonical fields', () => {
  const context = filterCatalogContextToActiveEntries(
    {
      available: [
        { id: 'std-active', description: 'Client wording', unit: 'bag', defaultRate: 999999 },
        { id: 'std-archived', description: 'Archived item', unit: 'ea' },
        { id: 'std-invented', description: 'Invented item', unit: 'day' },
      ],
      selected: [{ id: 'std-active', description: 'Selected wording', unit: 'wrong' }],
    },
    [
      { id: 'std-active', description: 'Canonical concrete', unit: 'm³', defaultRate: 3850 },
      { id: 'std-archived', description: 'Archived item', unit: 'ea', archivedAt: '2026-07-01T00:00:00.000Z' },
    ],
  )

  assert.deepEqual(context.available, [{ id: 'std-active', description: 'Canonical concrete', unit: 'm³', defaultRate: 3850 }])
  assert.deepEqual(context.selected, [{ id: 'std-active', description: 'Canonical concrete', unit: 'm³', defaultRate: 3850 }])
})

test('validates and includes capped chat history in the estimate AI context', () => {
  const result = validateEstimateAiRequest({
    message: 'Refine those quantities',
    history: [
      { role: 'user', content: 'Add concrete columns' },
      { role: 'assistant', content: 'I suggested a catalog item for review.' },
    ],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    const prompt = buildEstimateAiUserMessage(result.value)
    assert.match(prompt, /Add concrete columns/)
    assert.match(prompt, /I suggested a catalog item/)
  }

  assert.equal(validateEstimateAiRequest({ message: 'x', history: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x' })) }).ok, false)
  assert.equal(validateEstimateAiRequest({ message: 'x', history: [{ role: 'bot', content: 'not allowed' }] }).ok, false)
})

test('returns an ID-free manual fallback for unavailable or invalid AI output', () => {
  const fallback = buildEstimateAiManualFallback('provider')
  assert.equal(fallback.fallback, true)
  assert.equal(fallback.suggestions[0]?.source, 'manual')
  assert.equal(fallback.suggestions[0]?.stdId, undefined)
  assert.match(fallback.suggestions[0]?.reason ?? '', /manual|verify/i)

  const invalid = normalizeEstimateAiResponse('not structured JSON', catalog)
  assert.equal(invalid.fallback, true)
  assert.equal(invalid.suggestions[0]?.stdId, undefined)
})

test('validateEstimateAiRequest drops browser-supplied provider and model', () => {
  const result = validateEstimateAiRequest({
    message: 'Add rebar',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-expensive',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal('provider' in result.value, false)
  assert.equal('model' in result.value, false)
})

test('resolveEstimateAiConfig prefers saved workspace settings over env', () => {
  assert.deepEqual(
    resolveEstimateAiConfig({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, { LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o' }),
    { ok: true, provider: 'openrouter', model: 'openai/gpt-4o-mini' },
  )
})

test('resolveEstimateAiConfig falls back to env, then openai with no model override', () => {
  assert.deepEqual(
    resolveEstimateAiConfig(undefined, { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openai/gpt-4o' }),
    { ok: true, provider: 'openrouter', model: 'openai/gpt-4o' },
  )
  assert.deepEqual(resolveEstimateAiConfig(null, {}), { ok: true, provider: 'openai' })
  assert.deepEqual(resolveEstimateAiConfig({ provider: '  ', model: '' }, {}), { ok: true, provider: 'openai' })
})

test('resolveEstimateAiConfig rejects providers outside the allowlist', () => {
  assert.deepEqual(
    resolveEstimateAiConfig({ provider: 'evil-proxy' }, {}),
    { ok: false, reason: 'unsupported-provider', provider: 'evil-proxy' },
  )
  assert.equal(resolveEstimateAiConfig(undefined, { LLM_PROVIDER: 'anthropic' }).ok, false)
})
