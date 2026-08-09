import assert from 'node:assert/strict'
import test from 'node:test'
import {
  executeActionableReviewAiBatch,
  type ActionableReviewAiAdvice,
  type ActionableReviewAiRequestRow,
  type ActionableReviewCostEstimator,
  type ActionableReviewProviderCall,
} from './actionable-review-ai'
import {
  buildSourceSignature,
  type ApprovedCatalogMapping,
  type CatalogMappingCache,
} from './catalog-mapping-cache'
import type { ActionableReviewSettings } from './settings-schema'
import { createActionableReviewProviderCall } from './llm'

function settings(
  overrides: Partial<ActionableReviewSettings> = {},
): ActionableReviewSettings {
  return {
    stage: 'shadow',
    lowCostModel: 'gpt-4o-mini',
    escalationModel: 'gpt-4o',
    maxRows: 100,
    maxPromptTokens: 8_000,
    maxEstimatedCostMinor: 500,
    escalationEnabled: true,
    ...overrides,
  }
}

function candidate(
  overrides: Partial<ActionableReviewAiRequestRow['candidates'][number]> & {
    catalogId: string
  },
): ActionableReviewAiRequestRow['candidates'][number] {
  return {
    catalogId: overrides.catalogId,
    description: overrides.description ?? `Catalog ${overrides.catalogId}`,
    unit: overrides.unit ?? 'm',
    matchKind: overrides.matchKind ?? 'fuzzy',
    matchEvidence: overrides.matchEvidence ?? ['token-overlap'],
    ...(overrides.conversion !== undefined ? { conversion: overrides.conversion } : {}),
  }
}

function row(
  overrides: Partial<ActionableReviewAiRequestRow> & Pick<ActionableReviewAiRequestRow, 'sourceRowId'>,
): ActionableReviewAiRequestRow {
  return {
    sourceRowId: overrides.sourceRowId,
    description: overrides.description ?? `Row ${overrides.sourceRowId}`,
    unit: overrides.unit ?? 'm',
    structuralContext: overrides.structuralContext ?? ['section:concrete'],
    candidates: overrides.candidates ?? [
      candidate({ catalogId: 'std-a', matchKind: 'fuzzy' }),
      candidate({ catalogId: 'std-b', matchKind: 'fuzzy' }),
    ],
  }
}

function memoryCache(
  initial: Record<string, ApprovedCatalogMapping> = {},
): CatalogMappingCache & { store: Map<string, ApprovedCatalogMapping>; gets: string[] } {
  const store = new Map(Object.entries(initial))
  const gets: string[] = []
  return {
    store,
    gets,
    async get(key) {
      gets.push(key)
      return store.get(key) ?? null
    },
    async put() {
      throw new Error('AI batch must not human-approve via cache.put')
    },
    async remove() {
      throw new Error('AI batch must not remove cache entries')
    },
  }
}

function adviceFor(
  sourceRowId: string,
  overrides: Partial<ActionableReviewAiAdvice> = {},
): ActionableReviewAiAdvice {
  return {
    sourceRowId,
    decision: overrides.decision ?? 'match',
    confidence: overrides.confidence ?? 0.8,
    reason: overrides.reason ?? 'provider advice',
    ...(overrides.catalogId !== undefined ? { catalogId: overrides.catalogId } : {}),
    ...(overrides.conversionRuleId !== undefined
      ? { conversionRuleId: overrides.conversionRuleId }
      : {}),
    ...(overrides.proposedCatalogMetadata !== undefined
      ? { proposedCatalogMetadata: overrides.proposedCatalogMetadata }
      : {}),
  }
}

test('cache hit and exact local cases make zero provider calls', async () => {
  const description = 'PVC pipe 100mm'
  const unit = 'm'
  const sourceSignature = buildSourceSignature({ description, unit })
  const cache = memoryCache({
    'row-cache': {
      sourceSignature,
      catalogId: 'pipe-100',
      conversionRuleId: 'rule-pipe',
      approvedBy: 'model:prior',
      approvedAt: '2026-08-01T00:00:00.000Z',
    },
  })

  let providerCalls = 0
  const callProvider: ActionableReviewProviderCall = async () => {
    providerCalls += 1
    throw new Error('provider must not be called')
  }

  const result = await executeActionableReviewAiBatch({
    rows: [
      row({
        sourceRowId: 'row-cache',
        description,
        unit,
        candidates: [
          candidate({
            catalogId: 'pipe-100',
            matchKind: 'fuzzy',
            conversion: {
              ruleId: 'rule-pipe',
              sourceUnit: 'm',
              catalogUnit: 'm',
              catalogUnitsPerSourceUnit: '1',
              scope: 'global',
            },
          }),
          candidate({ catalogId: 'pipe-other', matchKind: 'fuzzy' }),
        ],
      }),
      row({
        sourceRowId: 'row-exact',
        description: 'Formwork slab',
        unit: 'm2',
        candidates: [
          candidate({
            catalogId: 'form-slab',
            description: 'Formwork slab',
            unit: 'm2',
            matchKind: 'exact',
            matchEvidence: ['exact-description'],
          }),
        ],
      }),
    ],
    settings: settings(),
    callProvider,
    estimateCostMinor: () => 10,
    cache,
  })

  assert.equal(providerCalls, 0)
  assert.equal(result.initialCallCount, 0)
  assert.equal(result.escalationCallCount, 0)
  assert.equal(result.cacheHitCount, 1)
  assert.equal(result.providerUnavailable, false)
  assert.equal(result.estimatedCostMinor, 0)
  assert.equal(result.advice.length, 2)

  const cached = result.advice.find((item) => item.sourceRowId === 'row-cache')
  assert.ok(cached)
  assert.equal(cached.decision, 'match')
  assert.equal(cached.catalogId, 'pipe-100')
  assert.equal(cached.conversionRuleId, 'rule-pipe')
  // Origin-stripped cache data is advice only — never human approval fields.
  assert.equal('approvedBy' in cached, false)
  assert.equal('origin' in cached, false)

  const exact = result.advice.find((item) => item.sourceRowId === 'row-exact')
  assert.ok(exact)
  assert.equal(exact.decision, 'match')
  assert.equal(exact.catalogId, 'form-slab')
})

test('cached mapping fails closed when signature or allowlists drift', async () => {
  const description = 'PVC pipe 100mm'
  const unit = 'm'
  const cache = memoryCache({
    'row-stale-sig': {
      sourceSignature: 'sha256:deadbeef',
      catalogId: 'pipe-100',
      approvedBy: 'model:prior',
      approvedAt: '2026-08-01T00:00:00.000Z',
    },
    'row-bad-catalog': {
      sourceSignature: buildSourceSignature({ description, unit }),
      catalogId: 'not-in-shortlist',
      approvedBy: 'model:prior',
      approvedAt: '2026-08-01T00:00:00.000Z',
    },
    'row-bad-rule': {
      sourceSignature: buildSourceSignature({ description, unit }),
      catalogId: 'pipe-100',
      conversionRuleId: 'rule-not-allowed',
      approvedBy: 'model:prior',
      approvedAt: '2026-08-01T00:00:00.000Z',
    },
  })

  let providerCalls = 0
  const callProvider: ActionableReviewProviderCall = async ({ rows }) => {
    providerCalls += 1
    return {
      advice: rows.map((item) =>
        adviceFor(item.sourceRowId, {
          decision: 'uncertain',
          confidence: 0.4,
          reason: 'needs review',
        }),
      ),
    }
  }

  const result = await executeActionableReviewAiBatch({
    rows: [
      row({
        sourceRowId: 'row-stale-sig',
        description,
        unit,
        candidates: [candidate({ catalogId: 'pipe-100', matchKind: 'fuzzy' })],
      }),
      row({
        sourceRowId: 'row-bad-catalog',
        description,
        unit,
        candidates: [candidate({ catalogId: 'pipe-100', matchKind: 'fuzzy' })],
      }),
      row({
        sourceRowId: 'row-bad-rule',
        description,
        unit,
        candidates: [
          candidate({
            catalogId: 'pipe-100',
            matchKind: 'conversion',
            conversion: {
              ruleId: 'rule-pipe',
              sourceUnit: 'length',
              catalogUnit: 'm',
              catalogUnitsPerSourceUnit: '6',
              scope: 'catalog_item',
            },
          }),
        ],
      }),
    ],
    settings: settings({ escalationEnabled: false }),
    callProvider,
    estimateCostMinor: () => 5,
    cache,
  })

  assert.equal(result.cacheHitCount, 0)
  assert.equal(providerCalls, 1)
  assert.equal(result.initialCallCount, 1)
  assert.ok(result.advice.every((item) => item.decision === 'uncertain'))
})

test('multiple ambiguous rows share one normal batch call', async () => {
  const seen: Array<{ model: string; rowIds: string[] }> = []
  const callProvider: ActionableReviewProviderCall = async ({ model, rows }) => {
    seen.push({ model, rowIds: rows.map((item) => item.sourceRowId) })
    assert.ok(rows.length <= 3)
    for (const item of rows) {
      assert.ok(item.candidates.length <= 3)
      assert.equal('quantity' in item, false)
      assert.equal('rate' in item, false)
    }
    return {
      advice: rows.map((item) =>
        adviceFor(item.sourceRowId, {
          decision: 'match',
          catalogId: item.candidates[0]!.catalogId,
          confidence: 0.7,
          reason: 'best candidate',
        }),
      ),
    }
  }

  const result = await executeActionableReviewAiBatch({
    rows: [
      row({ sourceRowId: 'a' }),
      row({ sourceRowId: 'b' }),
      row({ sourceRowId: 'c' }),
    ],
    settings: settings({ escalationEnabled: false }),
    callProvider,
    estimateCostMinor: () => 25,
    cache: memoryCache(),
  })

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0]?.rowIds, ['a', 'b', 'c'])
  assert.equal(seen[0]?.model, 'gpt-4o-mini')
  assert.equal(result.initialCallCount, 1)
  assert.equal(result.escalationCallCount, 0)
  assert.equal(result.estimatedCostMinor, 25)
  assert.equal(result.advice.length, 3)
})

test('optional escalation sends uncertain rows only and budget-checks', async () => {
  const seen: Array<{ model: string; rowIds: string[] }> = []
  let estimateCalls = 0
  const estimateCostMinor: ActionableReviewCostEstimator = ({ rows }) => {
    estimateCalls += 1
    return rows.length * 10
  }

  const callProvider: ActionableReviewProviderCall = async ({ model, rows }) => {
    seen.push({ model, rowIds: rows.map((item) => item.sourceRowId) })
    if (model === 'gpt-4o-mini') {
      return {
        advice: [
          adviceFor('keep', {
            decision: 'match',
            catalogId: 'std-a',
            confidence: 0.9,
            reason: 'clear match',
          }),
          adviceFor('maybe', {
            decision: 'uncertain',
            confidence: 0.4,
            reason: 'ambiguous',
          }),
          adviceFor('also-maybe', {
            decision: 'uncertain',
            confidence: 0.3,
            reason: 'ambiguous',
          }),
        ],
      }
    }
    return {
      advice: rows.map((item) =>
        adviceFor(item.sourceRowId, {
          decision: 'create',
          confidence: 0.75,
          reason: 'no safe match',
          proposedCatalogMetadata: {
            description: `New ${item.sourceRowId}`,
            unit: item.unit,
            aliases: [],
          },
        }),
      ),
    }
  }

  const result = await executeActionableReviewAiBatch({
    rows: [
      row({ sourceRowId: 'keep' }),
      row({ sourceRowId: 'maybe' }),
      row({ sourceRowId: 'also-maybe' }),
    ],
    settings: settings({ maxEstimatedCostMinor: 50 }),
    callProvider,
    estimateCostMinor,
    cache: memoryCache(),
  })

  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0]?.rowIds, ['keep', 'maybe', 'also-maybe'])
  assert.equal(seen[0]?.model, 'gpt-4o-mini')
  assert.deepEqual(seen[1]?.rowIds, ['maybe', 'also-maybe'])
  assert.equal(seen[1]?.model, 'gpt-4o')
  assert.equal(result.initialCallCount, 1)
  assert.equal(result.escalationCallCount, 1)
  assert.equal(result.estimatedCostMinor, 30 + 20)
  assert.equal(estimateCalls, 2)

  const escalated = result.advice.filter((item) => item.sourceRowId !== 'keep')
  assert.ok(escalated.every((item) => item.decision === 'create'))
  assert.equal(result.advice.find((item) => item.sourceRowId === 'keep')?.decision, 'match')
})

test('zero paid calls when budget is 0, over estimate, or provider disabled', async () => {
  let providerCalls = 0
  const callProvider: ActionableReviewProviderCall = async () => {
    providerCalls += 1
    throw new Error('must not call')
  }
  const rows = [row({ sourceRowId: 'a' }), row({ sourceRowId: 'b' })]

  const budgetZero = await executeActionableReviewAiBatch({
    rows,
    settings: settings({ maxEstimatedCostMinor: 0 }),
    callProvider,
    estimateCostMinor: () => 1,
    cache: memoryCache(),
  })
  assert.equal(providerCalls, 0)
  assert.equal(budgetZero.initialCallCount, 0)
  assert.equal(budgetZero.estimatedCostMinor, 0)
  assert.ok(budgetZero.advice.every((item) => item.decision === 'uncertain'))

  const overBudget = await executeActionableReviewAiBatch({
    rows,
    settings: settings({ maxEstimatedCostMinor: 10 }),
    callProvider,
    estimateCostMinor: () => 11,
    cache: memoryCache(),
  })
  assert.equal(providerCalls, 0)
  assert.equal(overBudget.initialCallCount, 0)
  assert.ok(overBudget.advice.every((item) => item.decision === 'uncertain'))

  const disabled = await executeActionableReviewAiBatch({
    rows,
    settings: settings({ stage: 'off', lowCostModel: undefined }),
    callProvider,
    estimateCostMinor: () => 1,
    cache: memoryCache(),
  })
  assert.equal(providerCalls, 0)
  assert.equal(disabled.initialCallCount, 0)
  assert.equal(disabled.providerUnavailable, true)
  assert.ok(disabled.advice.every((item) => item.decision === 'uncertain'))
})

test('escalation is skipped when remaining budget is insufficient', async () => {
  let providerCalls = 0
  const callProvider: ActionableReviewProviderCall = async ({ model, rows }) => {
    providerCalls += 1
    if (model !== 'gpt-4o-mini') throw new Error('escalation must not run')
    return {
      advice: rows.map((item) =>
        adviceFor(item.sourceRowId, {
          decision: 'uncertain',
          confidence: 0.2,
          reason: 'unclear',
        }),
      ),
    }
  }

  const estimates = [30, 40]
  const result = await executeActionableReviewAiBatch({
    rows: [row({ sourceRowId: 'u1' }), row({ sourceRowId: 'u2' })],
    settings: settings({ maxEstimatedCostMinor: 35 }),
    callProvider,
    estimateCostMinor: () => estimates.shift() ?? 0,
    cache: memoryCache(),
  })

  assert.equal(providerCalls, 1)
  assert.equal(result.initialCallCount, 1)
  assert.equal(result.escalationCallCount, 0)
  assert.equal(result.estimatedCostMinor, 30)
  assert.ok(result.advice.every((item) => item.decision === 'uncertain'))
})

test('provider failure malformed and partial responses fall back locally without throwing', async () => {
  const cache = memoryCache()

  const failed = await executeActionableReviewAiBatch({
    rows: [row({ sourceRowId: 'x' })],
    settings: settings({ escalationEnabled: false }),
    callProvider: async () => {
      throw new Error('network down')
    },
    estimateCostMinor: () => 5,
    cache,
  })
  assert.equal(failed.providerUnavailable, true)
  assert.equal(failed.initialCallCount, 1)
  assert.equal(failed.advice[0]?.decision, 'uncertain')
  assert.match(failed.advice[0]?.reason ?? '', /fallback|unavailable|manual/i)

  const malformed = await executeActionableReviewAiBatch({
    rows: [row({ sourceRowId: 'y' })],
    settings: settings({ escalationEnabled: false }),
    callProvider: async () => ({ notAdvice: true }),
    estimateCostMinor: () => 5,
    cache,
  })
  assert.equal(malformed.providerUnavailable, true)
  assert.equal(malformed.advice[0]?.decision, 'uncertain')

  const partial = await executeActionableReviewAiBatch({
    rows: [row({ sourceRowId: 'p1' }), row({ sourceRowId: 'p2' })],
    settings: settings({ escalationEnabled: false }),
    callProvider: async () => ({
      advice: [
        adviceFor('p1', {
          decision: 'match',
          catalogId: 'std-a',
          confidence: 0.8,
          reason: 'ok',
        }),
      ],
    }),
    estimateCostMinor: () => 5,
    cache,
  })
  assert.equal(partial.advice.find((item) => item.sourceRowId === 'p1')?.decision, 'match')
  assert.equal(partial.advice.find((item) => item.sourceRowId === 'p2')?.decision, 'uncertain')
  assert.equal(partial.providerUnavailable, true)
})

test('fail-closed parser rejects monetary authority unknown ids and invalid combinations', async () => {
  const ambiguous = row({
    sourceRowId: 'row-1',
    candidates: [
      candidate({
        catalogId: 'std-a',
        matchKind: 'fuzzy',
        conversion: {
          ruleId: 'rule-a',
          sourceUnit: 'length',
          catalogUnit: 'm',
          catalogUnitsPerSourceUnit: '6',
          scope: 'catalog_item',
        },
      }),
      candidate({ catalogId: 'std-b', matchKind: 'fuzzy' }),
    ],
  })

  async function runWithPayload(payload: unknown) {
    return executeActionableReviewAiBatch({
      rows: [ambiguous],
      settings: settings({ escalationEnabled: false }),
      callProvider: async () => payload,
      estimateCostMinor: () => 1,
      cache: memoryCache(),
    })
  }

  const forbiddenFields = ['rate', 'quantity', 'total', 'amount', 'price', 'conversionFactor']
  for (const field of forbiddenFields) {
    const result = await runWithPayload({
      advice: [
        {
          sourceRowId: 'row-1',
          decision: 'match',
          catalogId: 'std-a',
          confidence: 0.5,
          reason: 'x',
          [field]: 12,
        },
      ],
    })
    assert.equal(result.advice[0]?.decision, 'uncertain', `field ${field} must be rejected`)
  }

  const unknownRow = await runWithPayload({
    advice: [adviceFor('missing-row', { decision: 'dismiss', confidence: 0.5, reason: 'x' })],
  })
  assert.equal(unknownRow.advice[0]?.decision, 'uncertain')

  const outsideShortlist = await runWithPayload({
    advice: [
      adviceFor('row-1', {
        decision: 'match',
        catalogId: 'std-z',
        confidence: 0.5,
        reason: 'x',
      }),
    ],
  })
  assert.equal(outsideShortlist.advice[0]?.decision, 'uncertain')

  const badRule = await runWithPayload({
    advice: [
      adviceFor('row-1', {
        decision: 'match',
        catalogId: 'std-a',
        conversionRuleId: 'rule-other',
        confidence: 0.5,
        reason: 'x',
      }),
    ],
  })
  assert.equal(badRule.advice[0]?.decision, 'uncertain')

  const ruleOnWrongCandidate = await runWithPayload({
    advice: [
      adviceFor('row-1', {
        decision: 'match',
        catalogId: 'std-b',
        conversionRuleId: 'rule-a',
        confidence: 0.5,
        reason: 'x',
      }),
    ],
  })
  assert.equal(ruleOnWrongCandidate.advice[0]?.decision, 'uncertain')

  const matchWithCreateMeta = await runWithPayload({
    advice: [
      {
        sourceRowId: 'row-1',
        decision: 'match',
        catalogId: 'std-a',
        confidence: 0.5,
        reason: 'x',
        proposedCatalogMetadata: { description: 'N', unit: 'm', aliases: [] },
      },
    ],
  })
  assert.equal(matchWithCreateMeta.advice[0]?.decision, 'uncertain')

  const createWithCatalog = await runWithPayload({
    advice: [
      {
        sourceRowId: 'row-1',
        decision: 'create',
        catalogId: 'std-a',
        confidence: 0.5,
        reason: 'x',
        proposedCatalogMetadata: { description: 'N', unit: 'm', aliases: [] },
      },
    ],
  })
  assert.equal(createWithCatalog.advice[0]?.decision, 'uncertain')

  const badConfidence = await runWithPayload({
    advice: [
      adviceFor('row-1', {
        decision: 'dismiss',
        confidence: Number.NaN,
        reason: 'x',
      }),
    ],
  })
  assert.equal(badConfidence.advice[0]?.decision, 'uncertain')

  const outOfRange = await runWithPayload({
    advice: [adviceFor('row-1', { decision: 'dismiss', confidence: 1.5, reason: 'x' })],
  })
  assert.equal(outOfRange.advice[0]?.decision, 'uncertain')

  const longReason = await runWithPayload({
    advice: [
      adviceFor('row-1', {
        decision: 'dismiss',
        confidence: 0.5,
        reason: 'r'.repeat(2_000),
      }),
    ],
  })
  assert.equal(longReason.advice[0]?.decision, 'uncertain')

  const duplicateAdvice = await runWithPayload({
    advice: [
      adviceFor('row-1', { decision: 'dismiss', confidence: 0.5, reason: 'one' }),
      adviceFor('row-1', { decision: 'dismiss', confidence: 0.5, reason: 'two' }),
    ],
  })
  assert.equal(duplicateAdvice.advice[0]?.decision, 'uncertain')

  const unknownKey = await runWithPayload({
    advice: [
      {
        sourceRowId: 'row-1',
        decision: 'dismiss',
        confidence: 0.5,
        reason: 'x',
        extra: true,
      },
    ],
  })
  assert.equal(unknownKey.advice[0]?.decision, 'uncertain')
})

test('provider prompt rows stay closed: concise evidence and at most three candidates', async () => {
  let captured: ActionableReviewAiRequestRow[] = []
  const manyCandidates = Array.from({ length: 5 }, (_, index) =>
    candidate({
      catalogId: `std-${index}`,
      matchKind: 'fuzzy',
      matchEvidence: [`e-${index}`],
    }),
  )

  await executeActionableReviewAiBatch({
    rows: [
      row({
        sourceRowId: 'closed',
        description: 'Ambiguous item',
        unit: 'm',
        structuralContext: ['header:works', 'note:check'],
        candidates: manyCandidates,
      }),
    ],
    settings: settings({ escalationEnabled: false }),
    callProvider: async ({ rows }) => {
      captured = rows.map((item) => ({ ...item, candidates: [...item.candidates] }))
      return {
        advice: [
          adviceFor('closed', {
            decision: 'uncertain',
            confidence: 0.4,
            reason: 'still unclear',
          }),
        ],
      }
    },
    estimateCostMinor: () => 1,
    cache: memoryCache(),
  })

  assert.equal(captured.length, 1)
  const sent = captured[0]!
  assert.deepEqual(Object.keys(sent).sort(), [
    'candidates',
    'description',
    'sourceRowId',
    'structuralContext',
    'unit',
  ])
  assert.equal(sent.candidates.length, 3)
  assert.ok(
    sent.candidates.every((item) =>
      Object.keys(item).every((key) =>
        ['catalogId', 'description', 'unit', 'matchKind', 'matchEvidence', 'conversion'].includes(key),
      ),
    ),
  )
  assert.equal('pdf' in sent, false)
  assert.equal('catalog' in sent, false)
})

test('createActionableReviewProviderCall uses shared callLLM without inventing authority fields', async () => {
  const calls: Array<{ model?: string; content: string }> = []
  const provider = createActionableReviewProviderCall({
    callLLM: async (messages, _provider, model) => {
      calls.push({ model, content: messages.map((message) => message.content).join('\n') })
      return {
        content: JSON.stringify({
          advice: [
            {
              sourceRowId: 'r1',
              decision: 'uncertain',
              confidence: 0.2,
              reason: 'adapter',
            },
          ],
        }),
        provider: 'openai',
        model: model ?? 'gpt-4o-mini',
      }
    },
    provider: 'openai',
  })

  const payload = await provider({
    model: 'gpt-4o-mini',
    rows: [
      {
        sourceRowId: 'r1',
        description: 'Item',
        unit: 'm',
        structuralContext: ['s'],
        candidates: [
          {
            catalogId: 'c1',
            description: 'C1',
            unit: 'm',
            matchKind: 'fuzzy',
            matchEvidence: ['overlap'],
          },
        ],
      },
    ],
    maxPromptTokens: 1000,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.model, 'gpt-4o-mini')
  assert.match(calls[0]?.content ?? '', /r1/)
  assert.doesNotMatch(calls[0]?.content ?? '', /full catalog|PDF binary/i)
  assert.deepEqual(payload, {
    advice: [
      {
        sourceRowId: 'r1',
        decision: 'uncertain',
        confidence: 0.2,
        reason: 'adapter',
      },
    ],
  })
})
