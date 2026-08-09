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
