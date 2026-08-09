import type { Firestore } from 'firebase-admin/firestore'
import type { ActionableReview } from './actionable-review-projection'
import type { ActionableReviewMetrics } from './actionable-review-metrics'
import { assertNoRawMetricContent } from './actionable-review-metrics'
import { extractionRunPath } from './boq-extraction-storage'
import { getDb } from './db'

export const ACTIONABLE_REVIEW_SNAPSHOTS_COLLECTION = 'actionableReviewSnapshots'
export const ACTIONABLE_REVIEW_METRICS_COLLECTION = 'actionableReviewMetrics'

export class ActionableReviewStorageError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ActionableReviewStorageError'
    this.status = status
  }
}

export interface ActionableReviewDocumentStore {
  get(path: string): Promise<{ path: string; data: Record<string, unknown> } | null>
  /**
   * Create-only write. Returns `exists` when a document is already present so
   * callers can treat same-fingerprint POSTs as idempotent.
   */
  setIfAbsent(
    path: string,
    data: Record<string, unknown>,
  ): Promise<'created' | 'exists'>
  set(path: string, data: Record<string, unknown>): Promise<void>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  return value
}

function assertHashedFingerprint(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}: must be a sha256 fingerprint.`)
  }
  return value
}

function requireKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ActionableReviewStorageError(`Invalid ${label}: unexpected key "${key}".`)
    }
  }
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  return value
}

const SNAPSHOT_KEYS = new Set([
  'id',
  'extractionRunId',
  'actionableItemSuggestions',
  'dismissedEvidence',
  'representedRows',
  'validationSummary',
  'versions',
  'generatedAt',
  'mode',
])

const METRICS_KEYS = new Set([
  'fingerprint',
  'extractionRunId',
  'generatedAt',
  'mode',
  'counts',
  'cost',
  'quality',
])

const METRICS_COUNT_KEYS = new Set([
  'rawRowCount',
  'actionableCount',
  'dismissedCount',
  'representedCount',
  'locallyPreparedCatalogCount',
  'aiReviewedCount',
  'cacheHitCount',
  'initialCallCount',
  'escalationCallCount',
])

const METRICS_COST_KEYS = new Set(['estimatedCostMinor'])

const METRICS_QUALITY_KEYS = new Set([
  'rejectedReasonCounts',
  'decisionCounts',
  'sourceTotalDifference',
  'providerUnavailable',
])

const DECISION_COUNT_KEYS = new Set(['match', 'create', 'dismiss', 'uncertain'])

export function actionableReviewSnapshotPath(
  boqId: string,
  runId: string,
  fingerprint: string,
): string {
  const fp = assertHashedFingerprint(fingerprint, 'fingerprint')
  return `${extractionRunPath(boqId, runId)}/${ACTIONABLE_REVIEW_SNAPSHOTS_COLLECTION}/${fp}`
}

export function actionableReviewMetricsPath(
  boqId: string,
  runId: string,
  fingerprint: string,
): string {
  const fp = assertHashedFingerprint(fingerprint, 'fingerprint')
  return `${extractionRunPath(boqId, runId)}/${ACTIONABLE_REVIEW_METRICS_COLLECTION}/${fp}`
}

function parseStringRecord(value: unknown, label: string): Record<string, number> {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!nonEmptyString(key, `${label} key`)) {
      throw new ActionableReviewStorageError(`Invalid ${label}.`)
    }
    out[key] = nonNegativeInt(entry, `${label}.${key}`)
  }
  return out
}

/**
 * Fail-closed metrics parser. Rejects raw text / description / PDF / reason payloads.
 */
export function parseActionableReviewMetricsDocument(value: unknown): ActionableReviewMetrics {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError('Invalid actionable review metrics document.')
  }
  requireKeys(value, METRICS_KEYS, 'actionable review metrics')
  assertNoRawMetricContent(value)

  if (!isPlainRecord(value.counts)) {
    throw new ActionableReviewStorageError('Invalid metrics counts.')
  }
  requireKeys(value.counts, METRICS_COUNT_KEYS, 'metrics counts')
  if (!isPlainRecord(value.cost)) {
    throw new ActionableReviewStorageError('Invalid metrics cost.')
  }
  requireKeys(value.cost, METRICS_COST_KEYS, 'metrics cost')
  if (!isPlainRecord(value.quality)) {
    throw new ActionableReviewStorageError('Invalid metrics quality.')
  }
  requireKeys(value.quality, METRICS_QUALITY_KEYS, 'metrics quality')
  if (!isPlainRecord(value.quality.decisionCounts)) {
    throw new ActionableReviewStorageError('Invalid metrics decision counts.')
  }
  requireKeys(value.quality.decisionCounts, DECISION_COUNT_KEYS, 'metrics decision counts')

  const mode = value.mode
  if (mode !== 'shadow' && mode !== 'focused') {
    throw new ActionableReviewStorageError('Invalid metrics mode.')
  }

  const sourceTotalDifference = value.quality.sourceTotalDifference
  if (sourceTotalDifference !== null && typeof sourceTotalDifference !== 'string') {
    throw new ActionableReviewStorageError('Invalid metrics sourceTotalDifference.')
  }
  if (typeof value.quality.providerUnavailable !== 'boolean') {
    throw new ActionableReviewStorageError('Invalid metrics providerUnavailable.')
  }

  return {
    fingerprint: assertHashedFingerprint(
      nonEmptyString(value.fingerprint, 'fingerprint'),
      'fingerprint',
    ),
    extractionRunId: nonEmptyString(value.extractionRunId, 'extractionRunId'),
    generatedAt: nonEmptyString(value.generatedAt, 'generatedAt'),
    mode,
    counts: {
      rawRowCount: nonNegativeInt(value.counts.rawRowCount, 'rawRowCount'),
      actionableCount: nonNegativeInt(value.counts.actionableCount, 'actionableCount'),
      dismissedCount: nonNegativeInt(value.counts.dismissedCount, 'dismissedCount'),
      representedCount: nonNegativeInt(value.counts.representedCount, 'representedCount'),
      locallyPreparedCatalogCount: nonNegativeInt(
        value.counts.locallyPreparedCatalogCount,
        'locallyPreparedCatalogCount',
      ),
      aiReviewedCount: nonNegativeInt(value.counts.aiReviewedCount, 'aiReviewedCount'),
      cacheHitCount: nonNegativeInt(value.counts.cacheHitCount, 'cacheHitCount'),
      initialCallCount: nonNegativeInt(value.counts.initialCallCount, 'initialCallCount'),
      escalationCallCount: nonNegativeInt(value.counts.escalationCallCount, 'escalationCallCount'),
    },
    cost: {
      estimatedCostMinor: nonNegativeInt(value.cost.estimatedCostMinor, 'estimatedCostMinor'),
    },
    quality: {
      rejectedReasonCounts: parseStringRecord(
        value.quality.rejectedReasonCounts,
        'rejectedReasonCounts',
      ),
      decisionCounts: {
        match: nonNegativeInt(value.quality.decisionCounts.match, 'match'),
        create: nonNegativeInt(value.quality.decisionCounts.create, 'create'),
        dismiss: nonNegativeInt(value.quality.decisionCounts.dismiss, 'dismiss'),
        uncertain: nonNegativeInt(value.quality.decisionCounts.uncertain, 'uncertain'),
      },
      sourceTotalDifference: sourceTotalDifference as ActionableReviewMetrics['quality']['sourceTotalDifference'],
      providerUnavailable: value.quality.providerUnavailable,
    },
  }
}

/**
 * Fail-closed snapshot parser. Structural validation only — projection owns content.
 */
export function parseActionableReviewSnapshotDocument(value: unknown): ActionableReview {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError('Invalid actionable review snapshot document.')
  }
  requireKeys(value, SNAPSHOT_KEYS, 'actionable review snapshot')

  const mode = value.mode
  if (mode !== 'shadow' && mode !== 'focused') {
    throw new ActionableReviewStorageError('Invalid snapshot mode.')
  }
  if (!Array.isArray(value.actionableItemSuggestions)) {
    throw new ActionableReviewStorageError('Invalid actionableItemSuggestions.')
  }
  if (!Array.isArray(value.dismissedEvidence)) {
    throw new ActionableReviewStorageError('Invalid dismissedEvidence.')
  }
  if (!Array.isArray(value.representedRows)) {
    throw new ActionableReviewStorageError('Invalid representedRows.')
  }
  if (!isPlainRecord(value.validationSummary)) {
    throw new ActionableReviewStorageError('Invalid validationSummary.')
  }
  if (!isPlainRecord(value.versions)) {
    throw new ActionableReviewStorageError('Invalid versions.')
  }

  // Trust closed projection shape after key allowlist; deep monetary authority
  // remains server-generated and is never accepted from client routes.
  return value as unknown as ActionableReview
}

function toSnapshotDocument(review: ActionableReview): Record<string, unknown> {
  const parsed = parseActionableReviewSnapshotDocument(review)
  return structuredClone(parsed) as unknown as Record<string, unknown>
}

function toMetricsDocument(metrics: ActionableReviewMetrics): Record<string, unknown> {
  const parsed = parseActionableReviewMetricsDocument(metrics)
  return structuredClone(parsed) as unknown as Record<string, unknown>
}

export function createActionableReviewStorage(
  documents: ActionableReviewDocumentStore,
) {
  return {
    async writeSnapshot(
      boqId: string,
      runId: string,
      review: ActionableReview,
    ): Promise<'created' | 'exists'> {
      const fingerprint = assertHashedFingerprint(review.id, 'review.id')
      const path = actionableReviewSnapshotPath(boqId, runId, fingerprint)
      return documents.setIfAbsent(path, toSnapshotDocument(review))
    },

    async writeMetrics(
      boqId: string,
      runId: string,
      metrics: ActionableReviewMetrics,
    ): Promise<'created' | 'exists'> {
      const fingerprint = assertHashedFingerprint(metrics.fingerprint, 'metrics.fingerprint')
      const path = actionableReviewMetricsPath(boqId, runId, fingerprint)
      return documents.setIfAbsent(path, toMetricsDocument(metrics))
    },

    async getSnapshot(
      boqId: string,
      runId: string,
      fingerprint: string,
    ): Promise<ActionableReview | null> {
      const path = actionableReviewSnapshotPath(boqId, runId, fingerprint)
      const snap = await documents.get(path)
      if (!snap) return null
      return parseActionableReviewSnapshotDocument(snap.data)
    },

    async getMetrics(
      boqId: string,
      runId: string,
      fingerprint: string,
    ): Promise<ActionableReviewMetrics | null> {
      const path = actionableReviewMetricsPath(boqId, runId, fingerprint)
      const snap = await documents.get(path)
      if (!snap) return null
      return parseActionableReviewMetricsDocument(snap.data)
    },
  }
}

export type ActionableReviewStorage = ReturnType<typeof createActionableReviewStorage>

/**
 * Firestore adapter for shadow snapshot/metrics collections.
 * Server-mediated only — never imported into client bundles intentionally.
 */
export function createFirestoreActionableReviewDocuments(
  db: Firestore = getDb(),
): ActionableReviewDocumentStore {
  return {
    async get(path) {
      const snap = await db.doc(path).get()
      if (!snap.exists) return null
      return { path, data: (snap.data() ?? {}) as Record<string, unknown> }
    },
    async setIfAbsent(path, data) {
      const ref = db.doc(path)
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref)
        if (snap.exists) return 'exists' as const
        transaction.create(ref, data)
        return 'created' as const
      })
    },
    async set(path, data) {
      await db.doc(path).set(data)
    },
  }
}

export function createFirestoreActionableReviewStorage(
  db: Firestore = getDb(),
): ActionableReviewStorage {
  return createActionableReviewStorage(createFirestoreActionableReviewDocuments(db))
}
