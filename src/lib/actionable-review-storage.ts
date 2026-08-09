import type { Firestore } from 'firebase-admin/firestore'
import type { ActionableReviewAiAdvice } from './actionable-review-ai'
import type { ActionableReviewMetrics } from './actionable-review-metrics'
import { assertNoRawMetricContent } from './actionable-review-metrics'
import type {
  ActionableItemSuggestion,
  ActionableReview,
  ActionableReviewValidationSummary,
} from './actionable-review-projection'
import {
  parseExtractedPricingSnapshot,
  parsePricingNormalization,
  parseProposedCatalogMetadata,
  parseRowRole,
  parseSuggestionVersions,
} from './actionable-review-types'
import type { SourceCellMapping, SourceCellRef } from './boq-extraction-cell-mapping'
import type { RowRoleFinding } from './boq-row-role-classifier'
import type { RepresentedRowFinding } from './boq-represented-row-reconciliation'
import type { BoqSourceRef } from './boq-schema'
import type { CatalogCandidateSnapshot } from './catalog-candidate-shortlist'
import { extractionRunPath } from './boq-extraction-storage'
import { parseDecimalString, type DecimalString } from './decimal-string'
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

export type ActionableReviewBundleWriteResult =
  | {
    status: 'created'
    snapshot: ActionableReview
    metrics: ActionableReviewMetrics
  }
  | {
    status: 'exists'
    snapshot: ActionableReview
    metrics: ActionableReviewMetrics
  }

/**
 * Document adapter. Bundle writes are the only create path used by the route.
 * Implementations must never leave snapshot without metrics or vice versa.
 */
export type ActionableSuggestionDecisionStatus =
  | 'pending'
  | 'added_matched'
  | 'added_pending_catalog'
  | 'dismissed'
  | 'stale'

export interface ActionableReviewDocumentStore {
  get(path: string): Promise<{ path: string; data: Record<string, unknown> } | null>
  /**
   * Atomically create both documents when neither exists.
   * When either exists, both must exist or the store fails closed.
   * Returns existing pair data on collision without overwriting.
   */
  setBundleIfAbsent(input: {
    snapshotPath: string
    snapshotData: Record<string, unknown>
    metricsPath: string
    metricsData: Record<string, unknown>
  }): Promise<
    | { status: 'created' }
    | {
      status: 'exists'
      snapshotData: Record<string, unknown>
      metricsData: Record<string, unknown>
    }
  >
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

function plainString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
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

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ActionableReviewStorageError(`Invalid ${label}: unexpected key "${key}".`)
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      // Optional fields are handled by callers via optional sets.
      // This helper is for fully-required key sets only when used with requireAll.
    }
  }
}

function requireAllKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  label: string,
): void {
  for (const key of required) {
    if (!(key in value)) {
      throw new ActionableReviewStorageError(`Invalid ${label}: missing key "${key}".`)
    }
  }
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 0) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  return value
}

function parseOptionalDecimal(value: unknown, label: string): DecimalString | null {
  if (value === null) return null
  try {
    return parseDecimalString(value)
  } catch {
    throw new ActionableReviewStorageError(`Invalid ${label}: must be a canonical decimal string or null.`)
  }
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

const SUGGESTION_KEYS = new Set([
  'id',
  'extractionRunId',
  'sourceRowIds',
  'sourceRefs',
  'sourceCellMapping',
  'rowRole',
  'deterministicReasons',
  'suggestedSectionIndex',
  'extractedItem',
  'catalogCandidates',
  'aiAdvice',
  'normalization',
  'status',
  'versions',
])

const SUGGESTION_REQUIRED = new Set([
  'id',
  'extractionRunId',
  'sourceRowIds',
  'sourceRefs',
  'rowRole',
  'deterministicReasons',
  'suggestedSectionIndex',
  'extractedItem',
  'catalogCandidates',
  'status',
  'versions',
])

const SUGGESTION_STATUSES = new Set([
  'pending',
  'added_matched',
  'added_pending_catalog',
  'dismissed',
  'stale',
])

const FINDING_KEYS = new Set([
  'sourceRowId',
  'role',
  'reasonCodes',
  'deterministic',
  'sourceRef',
])

const REPRESENTED_KEYS = new Set([
  'sourceRowIds',
  'boqItemId',
  'reason',
  'sourceRefs',
])

const REPRESENTED_REASONS = new Set([
  'source_identity',
  'accepted_audit',
  'normalized_identity',
  'continuation',
])

const SOURCE_REF_KEYS = new Set(['page', 'table', 'row'])

const VALIDATION_SUMMARY_KEYS = new Set([
  'rawRowCount',
  'actionableCount',
  'dismissedCount',
  'representedCount',
  'locallyPreparedCatalogCount',
  'aiReviewedCount',
  'sourceTotalDifference',
  'rejectedReasonCounts',
])

const CANDIDATE_KEYS = new Set([
  'catalogId',
  'description',
  'unit',
  'matchKind',
  'score',
  'conversionRuleId',
])

const CANDIDATE_REQUIRED = new Set([
  'catalogId',
  'description',
  'unit',
  'matchKind',
  'score',
])

const MATCH_KINDS = new Set([
  'approved_history',
  'exact',
  'alias',
  'fuzzy',
  'conversion',
])

const AI_ADVICE_KEYS = new Set([
  'sourceRowId',
  'decision',
  'catalogId',
  'conversionRuleId',
  'proposedCatalogMetadata',
  'confidence',
  'reason',
])

const AI_DECISIONS = new Set(['match', 'create', 'dismiss', 'uncertain'])

const CELL_REF_KEYS = new Set(['sourceRowId', 'column', 'line'])

const CELL_MAPPING_KEYS = new Set([
  'sourceRowIds',
  'description',
  'unit',
  'quantity',
  'rate',
  'total',
  'materialRate',
  'materialTotal',
  'labourRate',
  'labourTotal',
  'amount',
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

function parseStringCountRecord(value: unknown, label: string): Record<string, number> {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    nonEmptyString(key, `${label} key`)
    out[key] = nonNegativeInt(entry, `${label}.${key}`)
  }
  return out
}

function parseSourceRef(value: unknown, label: string): BoqSourceRef {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, SOURCE_REF_KEYS, label)
  requireAllKeys(value, SOURCE_REF_KEYS, label)
  const page = nonNegativeInt(value.page, `${label}.page`)
  const table = nonNegativeInt(value.table, `${label}.table`)
  const row = nonNegativeInt(value.row, `${label}.row`)
  if (page < 1) {
    throw new ActionableReviewStorageError(`Invalid ${label}.page.`)
  }
  return { page, table, row }
}

function parseSourceRowIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`))
}

function parseCellRef(value: unknown, label: string): SourceCellRef {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, CELL_REF_KEYS, label)
  if (!('sourceRowId' in value) || !('column' in value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  const ref: SourceCellRef = {
    sourceRowId: nonEmptyString(value.sourceRowId, `${label}.sourceRowId`),
    column: nonNegativeInt(value.column, `${label}.column`),
  }
  if (value.line !== undefined) {
    ref.line = nonNegativeInt(value.line, `${label}.line`)
  }
  return ref
}

function parseSourceCellMapping(value: unknown, label: string): SourceCellMapping {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, CELL_MAPPING_KEYS, label)
  if (!('sourceRowIds' in value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  const mapping: SourceCellMapping = {
    sourceRowIds: parseSourceRowIds(value.sourceRowIds, `${label}.sourceRowIds`),
  }
  if (value.description !== undefined) {
    if (!Array.isArray(value.description)) {
      throw new ActionableReviewStorageError(`Invalid ${label}.description.`)
    }
    mapping.description = value.description.map((entry, index) =>
      parseCellRef(entry, `${label}.description[${index}]`),
    )
  }
  for (const field of [
    'unit',
    'quantity',
    'rate',
    'total',
    'materialRate',
    'materialTotal',
    'labourRate',
    'labourTotal',
    'amount',
  ] as const) {
    if (value[field] !== undefined) {
      mapping[field] = parseCellRef(value[field], `${label}.${field}`)
    }
  }
  return mapping
}

function parseCatalogCandidate(value: unknown, label: string): CatalogCandidateSnapshot {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, CANDIDATE_KEYS, label)
  requireAllKeys(value, CANDIDATE_REQUIRED, label)
  const matchKind = value.matchKind
  if (typeof matchKind !== 'string' || !MATCH_KINDS.has(matchKind)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.matchKind.`)
  }
  const candidate: CatalogCandidateSnapshot = {
    catalogId: nonEmptyString(value.catalogId, `${label}.catalogId`),
    description: plainString(value.description, `${label}.description`),
    unit: plainString(value.unit, `${label}.unit`),
    matchKind: matchKind as CatalogCandidateSnapshot['matchKind'],
    score: finiteNumber(value.score, `${label}.score`),
  }
  if (value.conversionRuleId !== undefined) {
    candidate.conversionRuleId = nonEmptyString(
      value.conversionRuleId,
      `${label}.conversionRuleId`,
    )
  }
  return candidate
}

function parseAiAdvice(value: unknown, label: string): ActionableReviewAiAdvice {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, AI_ADVICE_KEYS, label)
  for (const key of ['sourceRowId', 'decision', 'confidence', 'reason'] as const) {
    if (!(key in value)) {
      throw new ActionableReviewStorageError(`Invalid ${label}: missing key "${key}".`)
    }
  }
  const decision = value.decision
  if (typeof decision !== 'string' || !AI_DECISIONS.has(decision)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.decision.`)
  }
  const confidence = value.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ActionableReviewStorageError(`Invalid ${label}.confidence.`)
  }
  const reason = plainString(value.reason, `${label}.reason`)
  if (reason.trim() === '') {
    throw new ActionableReviewStorageError(`Invalid ${label}.reason.`)
  }

  const advice: ActionableReviewAiAdvice = {
    sourceRowId: nonEmptyString(value.sourceRowId, `${label}.sourceRowId`),
    decision: decision as ActionableReviewAiAdvice['decision'],
    confidence,
    reason,
  }

  if (value.catalogId !== undefined) {
    advice.catalogId = nonEmptyString(value.catalogId, `${label}.catalogId`)
  }
  if (value.conversionRuleId !== undefined) {
    advice.conversionRuleId = nonEmptyString(value.conversionRuleId, `${label}.conversionRuleId`)
  }
  if (value.proposedCatalogMetadata !== undefined) {
    try {
      advice.proposedCatalogMetadata = parseProposedCatalogMetadata(value.proposedCatalogMetadata)
    } catch {
      throw new ActionableReviewStorageError(`Invalid ${label}.proposedCatalogMetadata.`)
    }
  }

  // Fail-closed decision combinations (mirror Task 7 closed advice contract).
  if (decision === 'match') {
    if (!advice.catalogId || advice.proposedCatalogMetadata) {
      throw new ActionableReviewStorageError(`Invalid ${label}: match requires catalogId only.`)
    }
  } else if (decision === 'create') {
    if (advice.catalogId || advice.conversionRuleId || !advice.proposedCatalogMetadata) {
      throw new ActionableReviewStorageError(`Invalid ${label}: create requires metadata only.`)
    }
  } else if (advice.catalogId || advice.conversionRuleId || advice.proposedCatalogMetadata) {
    throw new ActionableReviewStorageError(`Invalid ${label}: ${decision} must be identity-only.`)
  }

  return advice
}

function parseSuggestion(value: unknown, label: string): ActionableItemSuggestion {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, SUGGESTION_KEYS, label)
  requireAllKeys(value, SUGGESTION_REQUIRED, label)

  const status = value.status
  if (typeof status !== 'string' || !SUGGESTION_STATUSES.has(status)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.status.`)
  }

  let extractedItem
  try {
    extractedItem = parseExtractedPricingSnapshot(value.extractedItem)
  } catch {
    throw new ActionableReviewStorageError(`Invalid ${label}.extractedItem.`)
  }

  let versions
  try {
    versions = parseSuggestionVersions(value.versions)
  } catch {
    throw new ActionableReviewStorageError(`Invalid ${label}.versions.`)
  }

  let rowRole
  try {
    rowRole = parseRowRole(value.rowRole)
  } catch {
    throw new ActionableReviewStorageError(`Invalid ${label}.rowRole.`)
  }

  if (!Array.isArray(value.deterministicReasons)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.deterministicReasons.`)
  }
  if (!Array.isArray(value.sourceRefs)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.sourceRefs.`)
  }
  if (!Array.isArray(value.catalogCandidates)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.catalogCandidates.`)
  }
  if (value.catalogCandidates.length > 3) {
    throw new ActionableReviewStorageError(`Invalid ${label}.catalogCandidates: max three.`)
  }

  const suggestion: ActionableItemSuggestion = {
    id: assertHashedFingerprint(nonEmptyString(value.id, `${label}.id`), `${label}.id`),
    extractionRunId: nonEmptyString(value.extractionRunId, `${label}.extractionRunId`),
    sourceRowIds: parseSourceRowIds(value.sourceRowIds, `${label}.sourceRowIds`),
    sourceRefs: value.sourceRefs.map((entry, index) =>
      parseSourceRef(entry, `${label}.sourceRefs[${index}]`),
    ),
    rowRole,
    deterministicReasons: value.deterministicReasons.map((entry, index) =>
      plainString(entry, `${label}.deterministicReasons[${index}]`),
    ),
    suggestedSectionIndex: nonNegativeInt(
      value.suggestedSectionIndex,
      `${label}.suggestedSectionIndex`,
    ),
    extractedItem,
    catalogCandidates: value.catalogCandidates.map((entry, index) =>
      parseCatalogCandidate(entry, `${label}.catalogCandidates[${index}]`),
    ),
    status: status as ActionableItemSuggestion['status'],
    versions,
  }

  if (value.sourceCellMapping !== undefined) {
    suggestion.sourceCellMapping = parseSourceCellMapping(
      value.sourceCellMapping,
      `${label}.sourceCellMapping`,
    )
  }
  if (value.aiAdvice !== undefined) {
    suggestion.aiAdvice = parseAiAdvice(value.aiAdvice, `${label}.aiAdvice`)
  }
  if (value.normalization !== undefined) {
    try {
      suggestion.normalization = parsePricingNormalization(value.normalization)
    } catch {
      throw new ActionableReviewStorageError(`Invalid ${label}.normalization.`)
    }
  }

  return suggestion
}

function parseRowRoleFinding(value: unknown, label: string): RowRoleFinding {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, FINDING_KEYS, label)
  requireAllKeys(value, FINDING_KEYS, label)
  if (typeof value.deterministic !== 'boolean') {
    throw new ActionableReviewStorageError(`Invalid ${label}.deterministic.`)
  }
  if (!Array.isArray(value.reasonCodes)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.reasonCodes.`)
  }
  let role
  try {
    role = parseRowRole(value.role)
  } catch {
    throw new ActionableReviewStorageError(`Invalid ${label}.role.`)
  }
  return {
    sourceRowId: nonEmptyString(value.sourceRowId, `${label}.sourceRowId`),
    role,
    reasonCodes: value.reasonCodes.map((entry, index) =>
      plainString(entry, `${label}.reasonCodes[${index}]`),
    ),
    deterministic: value.deterministic,
    sourceRef: parseSourceRef(value.sourceRef, `${label}.sourceRef`),
  }
}

function parseRepresentedFinding(value: unknown, label: string): RepresentedRowFinding {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, REPRESENTED_KEYS, label)
  requireAllKeys(value, REPRESENTED_KEYS, label)
  const reason = value.reason
  if (typeof reason !== 'string' || !REPRESENTED_REASONS.has(reason)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.reason.`)
  }
  if (!Array.isArray(value.sourceRefs)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.sourceRefs.`)
  }
  return {
    sourceRowIds: parseSourceRowIds(value.sourceRowIds, `${label}.sourceRowIds`),
    boqItemId: nonEmptyString(value.boqItemId, `${label}.boqItemId`),
    reason: reason as RepresentedRowFinding['reason'],
    sourceRefs: value.sourceRefs.map((entry, index) =>
      parseSourceRef(entry, `${label}.sourceRefs[${index}]`),
    ),
  }
}

function parseValidationSummary(value: unknown, label: string): ActionableReviewValidationSummary {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError(`Invalid ${label}.`)
  }
  requireExactKeys(value, VALIDATION_SUMMARY_KEYS, label)
  requireAllKeys(value, VALIDATION_SUMMARY_KEYS, label)
  return {
    rawRowCount: nonNegativeInt(value.rawRowCount, `${label}.rawRowCount`),
    actionableCount: nonNegativeInt(value.actionableCount, `${label}.actionableCount`),
    dismissedCount: nonNegativeInt(value.dismissedCount, `${label}.dismissedCount`),
    representedCount: nonNegativeInt(value.representedCount, `${label}.representedCount`),
    locallyPreparedCatalogCount: nonNegativeInt(
      value.locallyPreparedCatalogCount,
      `${label}.locallyPreparedCatalogCount`,
    ),
    aiReviewedCount: nonNegativeInt(value.aiReviewedCount, `${label}.aiReviewedCount`),
    sourceTotalDifference: parseOptionalDecimal(
      value.sourceTotalDifference,
      `${label}.sourceTotalDifference`,
    ),
    rejectedReasonCounts: parseStringCountRecord(
      value.rejectedReasonCounts,
      `${label}.rejectedReasonCounts`,
    ),
  }
}

/**
 * Fail-closed metrics parser. Rejects raw text / description / PDF / reason payloads.
 * Canonical-validates sourceTotalDifference when present.
 */
export function parseActionableReviewMetricsDocument(value: unknown): ActionableReviewMetrics {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError('Invalid actionable review metrics document.')
  }
  requireExactKeys(value, METRICS_KEYS, 'actionable review metrics')
  requireAllKeys(value, METRICS_KEYS, 'actionable review metrics')
  assertNoRawMetricContent(value)

  if (!isPlainRecord(value.counts)) {
    throw new ActionableReviewStorageError('Invalid metrics counts.')
  }
  requireExactKeys(value.counts, METRICS_COUNT_KEYS, 'metrics counts')
  requireAllKeys(value.counts, METRICS_COUNT_KEYS, 'metrics counts')
  if (!isPlainRecord(value.cost)) {
    throw new ActionableReviewStorageError('Invalid metrics cost.')
  }
  requireExactKeys(value.cost, METRICS_COST_KEYS, 'metrics cost')
  requireAllKeys(value.cost, METRICS_COST_KEYS, 'metrics cost')
  if (!isPlainRecord(value.quality)) {
    throw new ActionableReviewStorageError('Invalid metrics quality.')
  }
  requireExactKeys(value.quality, METRICS_QUALITY_KEYS, 'metrics quality')
  requireAllKeys(value.quality, METRICS_QUALITY_KEYS, 'metrics quality')
  if (!isPlainRecord(value.quality.decisionCounts)) {
    throw new ActionableReviewStorageError('Invalid metrics decision counts.')
  }
  requireExactKeys(value.quality.decisionCounts, DECISION_COUNT_KEYS, 'metrics decision counts')
  requireAllKeys(value.quality.decisionCounts, DECISION_COUNT_KEYS, 'metrics decision counts')

  const mode = value.mode
  if (mode !== 'shadow' && mode !== 'focused') {
    throw new ActionableReviewStorageError('Invalid metrics mode.')
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
      rejectedReasonCounts: parseStringCountRecord(
        value.quality.rejectedReasonCounts,
        'rejectedReasonCounts',
      ),
      decisionCounts: {
        match: nonNegativeInt(value.quality.decisionCounts.match, 'match'),
        create: nonNegativeInt(value.quality.decisionCounts.create, 'create'),
        dismiss: nonNegativeInt(value.quality.decisionCounts.dismiss, 'dismiss'),
        uncertain: nonNegativeInt(value.quality.decisionCounts.uncertain, 'uncertain'),
      },
      sourceTotalDifference: parseOptionalDecimal(
        value.quality.sourceTotalDifference,
        'metrics.sourceTotalDifference',
      ),
      providerUnavailable: value.quality.providerUnavailable,
    },
  }
}

/**
 * Deep fail-closed snapshot parser. Reuses Task 2 parsers for pricing/versions/roles.
 * Rejects nested unknowns, invalid money, status, IDs, and version fields.
 */
export function parseActionableReviewSnapshotDocument(value: unknown): ActionableReview {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewStorageError('Invalid actionable review snapshot document.')
  }
  requireExactKeys(value, SNAPSHOT_KEYS, 'actionable review snapshot')
  requireAllKeys(value, SNAPSHOT_KEYS, 'actionable review snapshot')

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

  let versions
  try {
    versions = parseSuggestionVersions(value.versions)
  } catch {
    throw new ActionableReviewStorageError('Invalid snapshot versions.')
  }

  return {
    id: assertHashedFingerprint(nonEmptyString(value.id, 'id'), 'id'),
    extractionRunId: nonEmptyString(value.extractionRunId, 'extractionRunId'),
    actionableItemSuggestions: value.actionableItemSuggestions.map((entry, index) =>
      parseSuggestion(entry, `actionableItemSuggestions[${index}]`),
    ),
    dismissedEvidence: value.dismissedEvidence.map((entry, index) =>
      parseRowRoleFinding(entry, `dismissedEvidence[${index}]`),
    ),
    representedRows: value.representedRows.map((entry, index) =>
      parseRepresentedFinding(entry, `representedRows[${index}]`),
    ),
    validationSummary: parseValidationSummary(value.validationSummary, 'validationSummary'),
    versions,
    generatedAt: nonEmptyString(value.generatedAt, 'generatedAt'),
    mode,
  }
}

export function toSnapshotDocument(review: ActionableReview): Record<string, unknown> {
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
    /**
     * Atomic snapshot+metrics create-or-read.
     * On exists, returns previously stored documents (content-stable).
     * Never leaves one document without the other.
     */
    async writeBundle(
      boqId: string,
      runId: string,
      review: ActionableReview,
      metrics: ActionableReviewMetrics,
    ): Promise<ActionableReviewBundleWriteResult> {
      const fingerprint = assertHashedFingerprint(review.id, 'review.id')
      if (metrics.fingerprint !== fingerprint) {
        throw new ActionableReviewStorageError(
          'Snapshot and metrics fingerprints must match.',
        )
      }
      const snapshotPath = actionableReviewSnapshotPath(boqId, runId, fingerprint)
      const metricsPath = actionableReviewMetricsPath(boqId, runId, fingerprint)
      const snapshotData = toSnapshotDocument(review)
      const metricsData = toMetricsDocument(metrics)

      const result = await documents.setBundleIfAbsent({
        snapshotPath,
        snapshotData,
        metricsPath,
        metricsData,
      })

      if (result.status === 'created') {
        return {
          status: 'created',
          snapshot: parseActionableReviewSnapshotDocument(snapshotData),
          metrics: parseActionableReviewMetricsDocument(metricsData),
        }
      }

      return {
        status: 'exists',
        snapshot: parseActionableReviewSnapshotDocument(result.snapshotData),
        metrics: parseActionableReviewMetricsDocument(result.metricsData),
      }
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

    /**
     * Pure in-memory status mutation for a bound snapshot document.
     * Does not re-fingerprint or regenerate the snapshot id.
     * Callers persist the result inside their ambient transaction.
     */
    applySuggestionStatus(
      snapshot: ActionableReview,
      suggestionId: string,
      status: ActionableSuggestionDecisionStatus,
    ): ActionableReview {
      return applySuggestionStatusToReview(snapshot, suggestionId, status)
    },

    /** Serialize a validated snapshot for an in-transaction update write. */
    toSnapshotWriteData(snapshot: ActionableReview): Record<string, unknown> {
      return toSnapshotDocument(snapshot)
    },
  }
}

/**
 * Apply a terminal/restored suggestion status without regenerating the fingerprint.
 * Used by decision transactions so status survives without re-projection.
 */
export function applySuggestionStatusToReview(
  snapshot: ActionableReview,
  suggestionId: string,
  status: ActionableSuggestionDecisionStatus,
): ActionableReview {
  const index = snapshot.actionableItemSuggestions.findIndex(
    (entry) => entry.id === suggestionId,
  )
  if (index < 0) {
    throw new ActionableReviewStorageError(
      'Actionable suggestion not found in snapshot.',
      404,
    )
  }
  const previous = snapshot.actionableItemSuggestions[index]!
  if (previous.status === status) {
    return structuredClone(snapshot)
  }
  const suggestions = snapshot.actionableItemSuggestions.map((entry, i) =>
    i === index ? { ...entry, status } : entry,
  )
  const validationSummary = adjustValidationSummaryForStatusTransition(
    snapshot.validationSummary,
    previous.status,
    status,
  )
  return {
    ...structuredClone(snapshot),
    actionableItemSuggestions: structuredClone(suggestions),
    validationSummary,
  }
}

function adjustValidationSummaryForStatusTransition(
  summary: ActionableReviewValidationSummary,
  from: ActionableItemSuggestion['status'],
  to: ActionableSuggestionDecisionStatus,
): ActionableReviewValidationSummary {
  let actionableCount = summary.actionableCount
  let dismissedCount = summary.dismissedCount
  let locallyPreparedCatalogCount = summary.locallyPreparedCatalogCount

  if (from === 'pending') actionableCount = Math.max(0, actionableCount - 1)
  if (from === 'dismissed') dismissedCount = Math.max(0, dismissedCount - 1)
  if (from === 'added_pending_catalog') {
    locallyPreparedCatalogCount = Math.max(0, locallyPreparedCatalogCount - 1)
  }

  if (to === 'pending') actionableCount += 1
  if (to === 'dismissed') dismissedCount += 1
  if (to === 'added_pending_catalog') locallyPreparedCatalogCount += 1

  return {
    ...summary,
    actionableCount,
    dismissedCount,
    locallyPreparedCatalogCount,
  }
}

/** Path for append-only human decision audits (not regenerated fingerprints). */
export function actionableSuggestionDecisionPath(
  boqId: string,
  runId: string,
  suggestionId: string,
): string {
  return `${extractionRunPath(boqId, runId)}/actionableSuggestionDecisions/${suggestionId}`
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
    async setBundleIfAbsent({ snapshotPath, snapshotData, metricsPath, metricsData }) {
      const snapshotRef = db.doc(snapshotPath)
      const metricsRef = db.doc(metricsPath)
      return db.runTransaction(async (transaction) => {
        const [snapshotSnap, metricsSnap] = await Promise.all([
          transaction.get(snapshotRef),
          transaction.get(metricsRef),
        ])
        if (snapshotSnap.exists || metricsSnap.exists) {
          if (!snapshotSnap.exists || !metricsSnap.exists) {
            throw new ActionableReviewStorageError(
              'Incomplete actionable review bundle.',
              500,
            )
          }
          return {
            status: 'exists' as const,
            snapshotData: (snapshotSnap.data() ?? {}) as Record<string, unknown>,
            metricsData: (metricsSnap.data() ?? {}) as Record<string, unknown>,
          }
        }
        transaction.create(snapshotRef, snapshotData)
        transaction.create(metricsRef, metricsData)
        return { status: 'created' as const }
      })
    },
  }
}

export function createFirestoreActionableReviewStorage(
  db: Firestore = getDb(),
): ActionableReviewStorage {
  return createActionableReviewStorage(createFirestoreActionableReviewDocuments(db))
}
