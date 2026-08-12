import type { ActionableReviewAiBatchResult } from './actionable-review-ai'
import { parseDecimalString, type DecimalString } from './decimal-string'

export interface ActionableReviewMetricsCounts {
  rawRowCount: number
  actionableCount: number
  dismissedCount: number
  representedCount: number
  locallyPreparedCatalogCount: number
  aiReviewedCount: number
  cacheHitCount: number
  initialCallCount: number
  escalationCallCount: number
}

export interface ActionableReviewMetricsCost {
  estimatedCostMinor: number
}

export interface ActionableReviewMetricsQuality {
  rejectedReasonCounts: Record<string, number>
  decisionCounts: {
    match: number
    create: number
    dismiss: number
    uncertain: number
  }
  sourceTotalDifference: DecimalString | null
  providerUnavailable: boolean
}

/**
 * Count/cost/quality metrics only.
 * Never stores raw text, descriptions, cells, PDF content, provider reasons, or catalog metadata.
 */
export interface ActionableReviewMetrics {
  fingerprint: string
  extractionRunId: string
  generatedAt: string
  mode: 'shadow' | 'focused'
  counts: ActionableReviewMetricsCounts
  cost: ActionableReviewMetricsCost
  quality: ActionableReviewMetricsQuality
}

/** Minimal review surface required to build metrics (avoids circular imports). */
export interface ActionableReviewMetricsSource {
  extractionRunId: string
  generatedAt: string
  mode: 'shadow' | 'focused'
  actionableItemSuggestions: ReadonlyArray<{
    aiAdvice?: { decision?: string } | undefined
  }>
  validationSummary: {
    rawRowCount: number
    actionableCount: number
    dismissedCount: number
    representedCount: number
    locallyPreparedCatalogCount: number
    aiReviewedCount: number
    sourceTotalDifference: DecimalString | null
    rejectedReasonCounts: Record<string, number>
  }
}

const FORBIDDEN_METRIC_KEYS = new Set([
  'rawText',
  'description',
  'descriptions',
  'cells',
  'rawCells',
  'pdf',
  'pdfContent',
  'providerReason',
  'reason',
  'reasons',
  'catalog',
  'catalogMetadata',
  'sourceRefs',
  'sourceRowIds',
  'advice',
  'content',
  'documentText',
  'proposedCatalogMetadata',
])

export function assertNoRawMetricContent(value: unknown, path = 'metrics'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawMetricContent(entry, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_METRIC_KEYS.has(key)) {
      throw new TypeError(`Metrics must not include raw content field "${key}" at ${path}.`)
    }
    assertNoRawMetricContent(child, `${path}.${key}`)
  }
}

function emptyDecisionCounts(): ActionableReviewMetricsQuality['decisionCounts'] {
  return { match: 0, create: 0, dismiss: 0, uncertain: 0 }
}

export function buildActionableReviewMetrics(input: {
  fingerprint: string
  review: ActionableReviewMetricsSource
  aiBatch: ActionableReviewAiBatchResult
}): ActionableReviewMetrics {
  const decisionCounts = emptyDecisionCounts()
  for (const suggestion of input.review.actionableItemSuggestions) {
    const decision = suggestion.aiAdvice?.decision
    if (
      decision === 'match'
      || decision === 'create'
      || decision === 'dismiss'
      || decision === 'uncertain'
    ) {
      decisionCounts[decision] += 1
    }
  }

  const summary = input.review.validationSummary
  let sourceTotalDifference: DecimalString | null = null
  if (summary.sourceTotalDifference !== null) {
    // Canonical-validate so metrics never persist non-decimal total deltas.
    sourceTotalDifference = parseDecimalString(summary.sourceTotalDifference)
  }
  const metrics: ActionableReviewMetrics = {
    fingerprint: input.fingerprint,
    extractionRunId: input.review.extractionRunId,
    generatedAt: input.review.generatedAt,
    mode: input.review.mode,
    counts: {
      rawRowCount: summary.rawRowCount,
      actionableCount: summary.actionableCount,
      dismissedCount: summary.dismissedCount,
      representedCount: summary.representedCount,
      locallyPreparedCatalogCount: summary.locallyPreparedCatalogCount,
      aiReviewedCount: summary.aiReviewedCount,
      cacheHitCount: input.aiBatch.cacheHitCount,
      initialCallCount: input.aiBatch.initialCallCount,
      escalationCallCount: input.aiBatch.escalationCallCount,
    },
    cost: {
      estimatedCostMinor: input.aiBatch.estimatedCostMinor,
    },
    quality: {
      rejectedReasonCounts: { ...summary.rejectedReasonCounts },
      decisionCounts,
      sourceTotalDifference,
      providerUnavailable: input.aiBatch.providerUnavailable,
    },
  }

  assertNoRawMetricContent(metrics)
  return metrics
}

/** Ordered rollout stages. Advance only one step at a time. */
export const ACTIONABLE_REVIEW_ROLLOUT_STAGE_ORDER = [
  'off',
  'shadow',
  'focused',
  'add_and_match',
  'default',
] as const

export type ActionableReviewRolloutStage =
  (typeof ACTIONABLE_REVIEW_ROLLOUT_STAGE_ORDER)[number]

/**
 * Explicit ops-facing gate thresholds.
 * Sample size 30 BOQs is the minimum defensible cohort for rate estimates
 * before promoting a workspace stage (rough binomial signal without claiming
 * production A/B significance).
 */
export const ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS = {
  /** local catalog preparation >= 70% */
  minLocalCatalogPreparationRate: 0.7,
  /** normal AI calls per BOQ <= 1 (initial calls; escalation separate) */
  maxNormalAiCallsPerBoq: 1,
  /** accepted AI-authored numeric values/factors = 0 */
  maxAcceptedAiAuthoredNumericValuesOrFactors: 0,
  /** projected reviewer-action reduction >= 50% */
  minProjectedReviewerActionReduction: 0.5,
  /** documented minimum sample size (BOQs) */
  minSampleSize: 30,
} as const

export type ActionableReviewRolloutThresholds =
  typeof ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS

/**
 * Aggregate-only rollout evidence. Never include raw descriptions, cells,
 * provider reasons, catalog metadata, normalized prices, or factors.
 */
export interface ActionableReviewRolloutAggregateEvidence {
  sampleSize: number
  /** 0-1 fraction of catalog candidate preparation resolved locally without AI. */
  localCatalogPreparationRate: number
  /** Average initial (non-escalation) AI calls per BOQ. */
  averageInitialAiCallsPerBoq: number
  /** Count of accepted AI-authored monetary values or conversion factors. */
  acceptedAiAuthoredNumericValuesOrFactors: number
  /** 0-1 projected reduction vs proposal-card reviewer actions. */
  projectedReviewerActionReduction: number
  /** 0-1 source-total mismatch escape rate in the candidate cohort. */
  sourceTotalMismatchEscapeRate: number
  /** 0-1 baseline escape rate from the control/prior stage cohort. */
  baselineSourceTotalMismatchEscapeRate: number
  /** Ops sign-off: false-dismissal/restoration review completed. */
  falseDismissalRestorationReviewCompleted: boolean
  /** Ops sign-off: approved/read-only mutation tests green. */
  approvedReadOnlyMutationTestsGreen: boolean
}

export interface ActionableReviewRolloutGateEvaluation {
  currentStage: ActionableReviewRolloutStage
  targetStage: ActionableReviewRolloutStage
  /** Stage that must remain in effect; never auto-written to settings. */
  retainedStage: ActionableReviewRolloutStage
  /** True only when ops may explicitly approve advancing to targetStage. */
  advanceAllowed: boolean
  failures: string[]
  thresholds: ActionableReviewRolloutThresholds
}

function rolloutStageIndex(stage: ActionableReviewRolloutStage): number {
  return ACTIONABLE_REVIEW_ROLLOUT_STAGE_ORDER.indexOf(stage)
}

function isRolloutStage(value: string): value is ActionableReviewRolloutStage {
  return (ACTIONABLE_REVIEW_ROLLOUT_STAGE_ORDER as readonly string[]).includes(value)
}

/**
 * Pure, server/ops-facing rollout gate.
 * Advisory only: never mutates workspace settings or persists evidence.
 * Missing, insufficient, or failed evidence retains the current stage.
 */
export function evaluateActionableReviewRolloutGate(input: {
  currentStage: ActionableReviewRolloutStage
  targetStage: ActionableReviewRolloutStage
  evidence?: ActionableReviewRolloutAggregateEvidence | null
}): ActionableReviewRolloutGateEvaluation {
  const thresholds = { ...ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS }
  const currentStage = input.currentStage
  const targetStage = input.targetStage
  const failures: string[] = []

  if (!isRolloutStage(currentStage) || !isRolloutStage(targetStage)) {
    failures.push('stage order violation: unknown rollout stage')
    const evaluation: ActionableReviewRolloutGateEvaluation = {
      currentStage,
      targetStage,
      retainedStage: isRolloutStage(currentStage) ? currentStage : 'off',
      advanceAllowed: false,
      failures,
      thresholds,
    }
    assertNoRawMetricContent(evaluation)
    return evaluation
  }

  if (currentStage === targetStage) {
    const evaluation: ActionableReviewRolloutGateEvaluation = {
      currentStage,
      targetStage,
      retainedStage: currentStage,
      advanceAllowed: false,
      failures: [],
      thresholds,
    }
    assertNoRawMetricContent(evaluation)
    return evaluation
  }

  const currentIndex = rolloutStageIndex(currentStage)
  const targetIndex = rolloutStageIndex(targetStage)
  if (targetIndex !== currentIndex + 1) {
    failures.push(
      `stage order violation: cannot skip or reverse from ${currentStage} to ${targetStage}`,
    )
    const evaluation: ActionableReviewRolloutGateEvaluation = {
      currentStage,
      targetStage,
      retainedStage: currentStage,
      advanceAllowed: false,
      failures,
      thresholds,
    }
    assertNoRawMetricContent(evaluation)
    return evaluation
  }

  const evidence = input.evidence
  if (evidence == null) {
    failures.push('missing rollout evidence: retain current stage')
    const evaluation: ActionableReviewRolloutGateEvaluation = {
      currentStage,
      targetStage,
      retainedStage: currentStage,
      advanceAllowed: false,
      failures,
      thresholds,
    }
    assertNoRawMetricContent(evaluation)
    return evaluation
  }

  if (
    !Number.isFinite(evidence.sampleSize)
    || evidence.sampleSize < thresholds.minSampleSize
  ) {
    failures.push(
      `insufficient sample size: need at least ${thresholds.minSampleSize} BOQs`,
    )
  }

  if (
    !Number.isFinite(evidence.localCatalogPreparationRate)
    || evidence.localCatalogPreparationRate < thresholds.minLocalCatalogPreparationRate
  ) {
    failures.push(
      `local catalog preparation below ${thresholds.minLocalCatalogPreparationRate * 100}%`,
    )
  }

  if (
    !Number.isFinite(evidence.averageInitialAiCallsPerBoq)
    || evidence.averageInitialAiCallsPerBoq > thresholds.maxNormalAiCallsPerBoq
  ) {
    failures.push(
      `normal AI calls per BOQ exceed ${thresholds.maxNormalAiCallsPerBoq} initial call`,
    )
  }

  if (
    !Number.isFinite(evidence.acceptedAiAuthoredNumericValuesOrFactors)
    || evidence.acceptedAiAuthoredNumericValuesOrFactors
      > thresholds.maxAcceptedAiAuthoredNumericValuesOrFactors
  ) {
    failures.push(
      'accepted AI-authored numeric values or factors must be 0',
    )
  }

  if (
    !Number.isFinite(evidence.projectedReviewerActionReduction)
    || evidence.projectedReviewerActionReduction
      < thresholds.minProjectedReviewerActionReduction
  ) {
    failures.push(
      `projected reviewer-action reduction below ${thresholds.minProjectedReviewerActionReduction * 100}%`,
    )
  }

  if (
    !Number.isFinite(evidence.sourceTotalMismatchEscapeRate)
    || !Number.isFinite(evidence.baselineSourceTotalMismatchEscapeRate)
    || evidence.sourceTotalMismatchEscapeRate
      > evidence.baselineSourceTotalMismatchEscapeRate
  ) {
    failures.push(
      'source-total mismatch escape rate exceeds baseline',
    )
  }

  if (evidence.falseDismissalRestorationReviewCompleted !== true) {
    failures.push(
      'false-dismissal/restoration review sign-off missing',
    )
  }

  if (evidence.approvedReadOnlyMutationTestsGreen !== true) {
    failures.push(
      'approved/read-only mutation tests sign-off missing',
    )
  }

  const advanceAllowed = failures.length === 0
  const evaluation: ActionableReviewRolloutGateEvaluation = {
    currentStage,
    targetStage,
    retainedStage: advanceAllowed ? targetStage : currentStage,
    advanceAllowed,
    failures,
    thresholds,
  }
  assertNoRawMetricContent(evaluation)
  return evaluation
}
