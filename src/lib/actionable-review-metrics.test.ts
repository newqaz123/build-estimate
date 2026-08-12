import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS,
  assertNoRawMetricContent,
  buildActionableReviewMetrics,
  evaluateActionableReviewRolloutGate,
  type ActionableReviewMetricsSource,
  type ActionableReviewRolloutAggregateEvidence,
  type ActionableReviewRolloutStage,
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

function passingEvidence(
  overrides: Partial<ActionableReviewRolloutAggregateEvidence> = {},
): ActionableReviewRolloutAggregateEvidence {
  return {
    sampleSize: ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minSampleSize,
    localCatalogPreparationRate:
      ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minLocalCatalogPreparationRate,
    averageInitialAiCallsPerBoq:
      ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.maxNormalAiCallsPerBoq,
    acceptedAiAuthoredNumericValuesOrFactors:
      ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.maxAcceptedAiAuthoredNumericValuesOrFactors,
    projectedReviewerActionReduction:
      ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minProjectedReviewerActionReduction,
    sourceTotalMismatchEscapeRate: 0.02,
    baselineSourceTotalMismatchEscapeRate: 0.02,
    falseDismissalRestorationReviewCompleted: true,
    approvedReadOnlyMutationTestsGreen: true,
    ...overrides,
  }
}

test('rollout thresholds document the approved metric gates and sample size', () => {
  assert.equal(ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minLocalCatalogPreparationRate, 0.7)
  assert.equal(ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.maxNormalAiCallsPerBoq, 1)
  assert.equal(
    ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.maxAcceptedAiAuthoredNumericValuesOrFactors,
    0,
  )
  assert.equal(
    ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minProjectedReviewerActionReduction,
    0.5,
  )
  assert.equal(ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minSampleSize, 30)
})

test('successful gate allows only the immediate next stage and retains the target', () => {
  const evaluation = evaluateActionableReviewRolloutGate({
    currentStage: 'focused',
    targetStage: 'add_and_match',
    evidence: passingEvidence(),
  })

  assert.equal(evaluation.advanceAllowed, true)
  assert.equal(evaluation.retainedStage, 'add_and_match')
  assert.deepEqual(evaluation.failures, [])
  assert.equal(
    evaluation.thresholds.minLocalCatalogPreparationRate,
    ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minLocalCatalogPreparationRate,
  )
})

test('missing evidence keeps the current stage', () => {
  for (const evidence of [undefined, null] as const) {
    const evaluation = evaluateActionableReviewRolloutGate({
      currentStage: 'shadow',
      targetStage: 'focused',
      evidence,
    })
    assert.equal(evaluation.advanceAllowed, false)
    assert.equal(evaluation.retainedStage, 'shadow')
    assert.ok(
      evaluation.failures.some((failure: string) => /missing|absent|evidence/i.test(failure)),
      `expected missing-evidence failure, got ${evaluation.failures.join('; ')}`,
    )
  }
})

test('insufficient sample size keeps the current stage', () => {
  const evaluation = evaluateActionableReviewRolloutGate({
    currentStage: 'focused',
    targetStage: 'add_and_match',
    evidence: passingEvidence({
      sampleSize: ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS.minSampleSize - 1,
    }),
  })

  assert.equal(evaluation.advanceAllowed, false)
  assert.equal(evaluation.retainedStage, 'focused')
  assert.ok(
    evaluation.failures.some((failure: string) => /sample/i.test(failure)),
    `expected sample-size failure, got ${evaluation.failures.join('; ')}`,
  )
})

test('each metric threshold failure keeps the current stage', () => {
  const cases: Array<{
    name: string
    evidence: Partial<ActionableReviewRolloutAggregateEvidence>
    pattern: RegExp
  }> = [
    {
      name: 'local catalog preparation',
      evidence: { localCatalogPreparationRate: 0.699 },
      pattern: /local catalog|catalog preparation/i,
    },
    {
      name: 'normal AI calls',
      evidence: { averageInitialAiCallsPerBoq: 1.01 },
      pattern: /ai call|initial call/i,
    },
    {
      name: 'accepted AI-authored numerics',
      evidence: { acceptedAiAuthoredNumericValuesOrFactors: 1 },
      pattern: /ai-authored|numeric|factor/i,
    },
    {
      name: 'reviewer-action reduction',
      evidence: { projectedReviewerActionReduction: 0.499 },
      pattern: /reviewer-action|action reduction/i,
    },
    {
      name: 'source-total mismatch escape vs baseline',
      evidence: {
        sourceTotalMismatchEscapeRate: 0.05,
        baselineSourceTotalMismatchEscapeRate: 0.04,
      },
      pattern: /source-total|mismatch escape/i,
    },
    {
      name: 'false-dismissal restoration sign-off',
      evidence: { falseDismissalRestorationReviewCompleted: false },
      pattern: /false-dismissal|restoration/i,
    },
    {
      name: 'approved read-only mutation sign-off',
      evidence: { approvedReadOnlyMutationTestsGreen: false },
      pattern: /read-only|mutation/i,
    },
  ]

  for (const testCase of cases) {
    const evaluation = evaluateActionableReviewRolloutGate({
      currentStage: 'add_and_match',
      targetStage: 'default',
      evidence: passingEvidence(testCase.evidence),
    })
    assert.equal(
      evaluation.advanceAllowed,
      false,
      `${testCase.name} should block advance`,
    )
    assert.equal(evaluation.retainedStage, 'add_and_match')
    assert.ok(
      evaluation.failures.some((failure: string) => testCase.pattern.test(failure)),
      `${testCase.name}: expected ${testCase.pattern} in ${evaluation.failures.join('; ')}`,
    )
  }
})

test('stage-order violations reject skips and unknown reverse jumps', () => {
  const skips: Array<{
    current: ActionableReviewRolloutStage
    target: ActionableReviewRolloutStage
  }> = [
    { current: 'off', target: 'focused' },
    { current: 'shadow', target: 'add_and_match' },
    { current: 'focused', target: 'default' },
    { current: 'off', target: 'default' },
    { current: 'focused', target: 'shadow' },
  ]

  for (const { current, target } of skips) {
    const evaluation = evaluateActionableReviewRolloutGate({
      currentStage: current,
      targetStage: target,
      evidence: passingEvidence(),
    })
    assert.equal(evaluation.advanceAllowed, false)
    assert.equal(evaluation.retainedStage, current)
    assert.ok(
      evaluation.failures.some((failure: string) => /stage|order|skip/i.test(failure)),
      `${current} -> ${target}: expected stage-order failure, got ${evaluation.failures.join('; ')}`,
    )
  }
})

test('same-stage evaluation retains current stage without requiring evidence', () => {
  const evaluation = evaluateActionableReviewRolloutGate({
    currentStage: 'default',
    targetStage: 'default',
  })
  assert.equal(evaluation.advanceAllowed, false)
  assert.equal(evaluation.retainedStage, 'default')
  assert.deepEqual(evaluation.failures, [])
})

test('pure evaluator never mutates settings or evidence inputs', () => {
  const settings = Object.freeze({
    stage: 'focused' as const,
    maxRows: 100,
    maxPromptTokens: 8_000,
    maxEstimatedCostMinor: 0,
    escalationEnabled: true,
  })
  const evidence = Object.freeze(passingEvidence())
  const settingsBefore = structuredClone(settings)
  const evidenceBefore = structuredClone(evidence)

  const evaluation = evaluateActionableReviewRolloutGate({
    currentStage: settings.stage,
    targetStage: 'add_and_match',
    evidence,
  })

  assert.equal(evaluation.advanceAllowed, true)
  assert.deepEqual(settings, settingsBefore)
  assert.deepEqual(evidence, evidenceBefore)
  assert.equal(
    Object.prototype.hasOwnProperty.call(evaluation, 'settings'),
    false,
  )
  assert.doesNotThrow(() => assertNoRawMetricContent(evaluation))
  assert.doesNotThrow(() => assertNoRawMetricContent(evidence))
})

test('source-total mismatch escape equal to baseline still passes', () => {
  const evaluation = evaluateActionableReviewRolloutGate({
    currentStage: 'shadow',
    targetStage: 'focused',
    evidence: passingEvidence({
      sourceTotalMismatchEscapeRate: 0.1,
      baselineSourceTotalMismatchEscapeRate: 0.1,
    }),
  })
  assert.equal(evaluation.advanceAllowed, true)
  assert.equal(evaluation.retainedStage, 'focused')
})

test('ordered stage progression off->shadow->focused->add_and_match->default', () => {
  const path: ActionableReviewRolloutStage[] = [
    'off',
    'shadow',
    'focused',
    'add_and_match',
    'default',
  ]
  for (let index = 0; index < path.length - 1; index += 1) {
    const current = path[index]!
    const target = path[index + 1]!
    const evaluation = evaluateActionableReviewRolloutGate({
      currentStage: current,
      targetStage: target,
      evidence: passingEvidence(),
    })
    assert.equal(
      evaluation.advanceAllowed,
      true,
      `${current} -> ${target} should advance`,
    )
    assert.equal(evaluation.retainedStage, target)
  }
})
