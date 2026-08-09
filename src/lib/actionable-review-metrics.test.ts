import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertNoRawMetricContent,
  buildActionableReviewMetrics,
  type ActionableReviewMetricsSource,
} from './actionable-review-metrics'
import type { ActionableReviewAiBatchResult } from './actionable-review-ai'

function reviewSource(
  overrides: Partial<ActionableReviewMetricsSource> = {},
): ActionableReviewMetricsSource {
  return {
    extractionRunId: 'run-1',
    generatedAt: '2026-08-08T12:00:00.000Z',
    mode: 'shadow',
    actionableItemSuggestions: [
      { aiAdvice: { decision: 'match' } },
      { aiAdvice: { decision: 'uncertain' } },
      { aiAdvice: { decision: 'create' } },
    ],
    validationSummary: {
      rawRowCount: 10,
      actionableCount: 3,
      dismissedCount: 5,
      representedCount: 2,
      locallyPreparedCatalogCount: 1,
      aiReviewedCount: 2,
      sourceTotalDifference: '12.50',
      rejectedReasonCounts: { note_label: 1 },
    },
    ...overrides,
  }
}

function batch(
  overrides: Partial<ActionableReviewAiBatchResult> = {},
): ActionableReviewAiBatchResult {
  return {
    advice: [],
    cacheHitCount: 1,
    initialCallCount: 1,
    escalationCallCount: 0,
    estimatedCostMinor: 42,
    providerUnavailable: false,
    ...overrides,
  }
}

test('buildActionableReviewMetrics keeps count/cost/quality only', () => {
  const metrics = buildActionableReviewMetrics({
    fingerprint: 'sha256:' + 'f'.repeat(64),
    review: reviewSource(),
    aiBatch: batch(),
  })

  assert.equal(metrics.counts.rawRowCount, 10)
  assert.equal(metrics.counts.actionableCount, 3)
  assert.equal(metrics.counts.cacheHitCount, 1)
  assert.equal(metrics.counts.initialCallCount, 1)
  assert.equal(metrics.cost.estimatedCostMinor, 42)
  assert.equal(metrics.quality.decisionCounts.match, 1)
  assert.equal(metrics.quality.decisionCounts.uncertain, 1)
  assert.equal(metrics.quality.decisionCounts.create, 1)
  assert.equal(metrics.quality.sourceTotalDifference, '12.5')
  assert.equal(metrics.quality.providerUnavailable, false)
  assert.deepEqual(Object.keys(metrics).sort(), [
    'cost',
    'counts',
    'extractionRunId',
    'fingerprint',
    'generatedAt',
    'mode',
    'quality',
  ])
})

test('metrics builder and guard reject raw text/description/PDF/reason leakage', () => {
  assert.throws(
    () => assertNoRawMetricContent({
      fingerprint: 'x',
      rawText: 'from pdf page 3',
    }),
    /raw content field "rawText"/,
  )
  assert.throws(
    () => assertNoRawMetricContent({
      quality: { providerReason: 'looks like concrete' },
    }),
    /raw content field "providerReason"/,
  )
  assert.throws(
    () => assertNoRawMetricContent({
      catalogMetadata: { description: 'secret' },
    }),
    /raw content field "catalogMetadata"/,
  )
  assert.throws(
    () => assertNoRawMetricContent({
      content: 'document body',
    }),
    /raw content field "content"/,
  )

  const metrics = buildActionableReviewMetrics({
    fingerprint: 'sha256:' + '1'.repeat(64),
    review: reviewSource(),
    aiBatch: batch({ providerUnavailable: true }),
  })
  assert.doesNotThrow(() => assertNoRawMetricContent(metrics))
  assert.equal(metrics.quality.providerUnavailable, true)
  assert.equal(
    JSON.stringify(metrics).includes('looks like'),
    false,
  )
  assert.equal(
    JSON.stringify(metrics).includes('Ready mix'),
    false,
  )
})
