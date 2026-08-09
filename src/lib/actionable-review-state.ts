import {
  parseExtractedPricingSnapshot,
  parsePricingNormalization,
  parseProposedCatalogMetadata,
  parseRowRole,
  parseSuggestionVersions,
  type SuggestionVersions,
} from './actionable-review-types'
import type {
  ActionableItemSuggestion,
  ActionableReview,
  ActionableReviewValidationSummary,
} from './actionable-review-projection'
import type { ActionableReviewAiAdvice } from './actionable-review-ai'
import type { SourceCellMapping, SourceCellRef } from './boq-extraction-cell-mapping'
import type { BoqSourceRef } from './boq-schema'
import type { CatalogCandidateSnapshot } from './catalog-candidate-shortlist'
import type { RepresentedRowFinding } from './boq-represented-row-reconciliation'
import type { RowRoleFinding } from './boq-row-role-classifier'
import { parseDecimalString, type DecimalString } from './decimal-string'

export interface ActionableReviewState {
  snapshot: ActionableReview | null
  selectedSuggestionId: string | null
  auditOpen: boolean
  loading: boolean
  submittingSuggestionId: string | null
  error: string | null
}

export type ActionableReviewAction =
  | { type: 'load_started' }
  | { type: 'load_succeeded'; snapshot: ActionableReview }
  | { type: 'load_failed'; error: string }
  | { type: 'requests_cancelled' }
  | { type: 'decision_started'; suggestionId: string }
  | { type: 'decision_succeeded'; suggestionId: string }
  | { type: 'decision_failed'; suggestionId: string; error: string }
  | { type: 'select_suggestion'; suggestionId: string | null }
  | { type: 'toggle_audit' }
  | { type: 'clear_error' }

export interface ActionableReviewVersionScope {
  extractionFingerprint: string
  boqSectionsFingerprint: string
  catalogFingerprint: string
  conversionFingerprint: string
}

export const ACTIONABLE_SUGGESTION_STATUSES = [
  'pending',
  'added_matched',
  'added_pending_catalog',
  'dismissed',
  'stale',
] as const

type ActionableSuggestionStatus = (typeof ACTIONABLE_SUGGESTION_STATUSES)[number]
const ACTIONABLE_STATUS_SET = new Set<string>(ACTIONABLE_SUGGESTION_STATUSES)
const REVIEW_MODES = new Set(['shadow', 'focused'])
const CANDIDATE_MATCH_KINDS = new Set([
  'approved_history',
  'exact',
  'alias',
  'fuzzy',
  'conversion',
])
const REPRESENTED_REASONS = new Set([
  'source_identity',
  'accepted_audit',
  'normalized_identity',
  'continuation',
])
const MAX_STRING_LENGTH = 4_000
const MAX_REASON_LENGTH = 500

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function nonEmptyString(value: unknown, label: string, max = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new TypeError(`Invalid ${label}.`)
  }
  return value
}

function plainString(value: unknown, label: string, max = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new TypeError(`Invalid ${label}.`)
  }
  return value
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Invalid ${label}: unexpected key "${key}".`)
  }
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  exactKeys(value, keys, label)
  for (const key of keys) {
    if (!(key in value)) throw new TypeError(`Invalid ${label}: missing ${key}.`)
  }
}

function finiteInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new TypeError(`Invalid ${label}.`)
  }
  return value
}

function finiteNumber(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${label}.`)
  }
  if (minimum !== undefined && value < minimum) throw new TypeError(`Invalid ${label}.`)
  return value
}

function canonicalDecimal(value: unknown, label: string): DecimalString {
  try {
    return parseDecimalString(value)
  } catch {
    throw new TypeError(`Invalid ${label}.`)
  }
}

function parseHash(value: unknown, label: string): string {
  const string = nonEmptyString(value, label, 128)
  if (!/^sha256:[a-f0-9]{64}$/.test(string)) throw new TypeError(`Invalid ${label}.`)
  return string
}

function parseSourceRef(value: unknown, label: string): BoqSourceRef {
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  requireKeys(value, ['page', 'table', 'row'], label)
  return {
    page: finiteInteger(value.page, `${label}.page`, 1),
    table: finiteInteger(value.table, `${label}.table`),
    row: finiteInteger(value.row, `${label}.row`),
  }
}

function parseSourceCellRef(value: unknown, label: string): SourceCellRef {
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  exactKeys(value, ['sourceRowId', 'column', 'line'], label)
  const parsed: SourceCellRef = {
    sourceRowId: nonEmptyString(value.sourceRowId, `${label}.sourceRowId`, 256),
    column: finiteInteger(value.column, `${label}.column`),
  }
  if (value.line !== undefined) parsed.line = finiteInteger(value.line, `${label}.line`)
  return parsed
}

const SOURCE_MAPPING_FIELDS = [
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
] as const

function parseSourceCellMapping(
  value: unknown,
  suggestionSourceRowIds: ReadonlySet<string>,
): SourceCellMapping {
  if (!isPlainRecord(value)) throw new TypeError('Invalid sourceCellMapping.')
  exactKeys(value, ['sourceRowIds', ...SOURCE_MAPPING_FIELDS], 'sourceCellMapping')
  if (!Array.isArray(value.sourceRowIds) || value.sourceRowIds.length === 0) {
    throw new TypeError('Invalid sourceCellMapping.sourceRowIds.')
  }
  const sourceRowIds = value.sourceRowIds.map((rowId, index) =>
    nonEmptyString(rowId, `sourceCellMapping.sourceRowIds[${index}]`, 256),
  )
  if (new Set(sourceRowIds).size !== sourceRowIds.length) throw new TypeError('Duplicate source cell row ids.')
  if (sourceRowIds.some((rowId) => !suggestionSourceRowIds.has(rowId))) {
    throw new TypeError('Invalid sourceCellMapping.sourceRowIds.')
  }

  const parsed: SourceCellMapping = { sourceRowIds }
  for (const field of SOURCE_MAPPING_FIELDS) {
    const fieldValue = value[field]
    if (fieldValue === undefined) continue
    if (field === 'description') {
      if (!Array.isArray(fieldValue) || fieldValue.length === 0) throw new TypeError('Invalid source description mapping.')
      parsed.description = fieldValue.map((ref, index) => parseSourceCellRef(ref, `sourceCellMapping.description[${index}]`))
    } else {
      parsed[field] = parseSourceCellRef(fieldValue, `sourceCellMapping.${field}`) as never
    }
  }
  return parsed
}

function parseCandidate(value: unknown, label: string): CatalogCandidateSnapshot {
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  exactKeys(value, ['catalogId', 'description', 'unit', 'matchKind', 'score', 'conversionRuleId'], label)
  const matchKind = nonEmptyString(value.matchKind, `${label}.matchKind`, 32)
  if (!CANDIDATE_MATCH_KINDS.has(matchKind)) throw new TypeError(`Invalid ${label}.matchKind.`)
  const parsed: CatalogCandidateSnapshot = {
    catalogId: nonEmptyString(value.catalogId, `${label}.catalogId`, 256),
    description: plainString(value.description, `${label}.description`),
    unit: plainString(value.unit, `${label}.unit`, 128),
    matchKind: matchKind as CatalogCandidateSnapshot['matchKind'],
    score: finiteNumber(value.score, `${label}.score`),
  }
  if (value.conversionRuleId !== undefined) {
    parsed.conversionRuleId = nonEmptyString(value.conversionRuleId, `${label}.conversionRuleId`, 256)
  }
  return parsed
}

function parseAdvice(
  value: unknown,
  sourceRowIds: ReadonlySet<string>,
  candidates: readonly CatalogCandidateSnapshot[],
  label: string,
): ActionableReviewAiAdvice {
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  exactKeys(value, [
    'sourceRowId',
    'decision',
    'catalogId',
    'conversionRuleId',
    'proposedCatalogMetadata',
    'confidence',
    'reason',
  ], label)
  const sourceRowId = nonEmptyString(value.sourceRowId, `${label}.sourceRowId`, 256)
  if (!sourceRowIds.has(sourceRowId)) throw new TypeError(`Invalid ${label}.sourceRowId.`)
  const decision = nonEmptyString(value.decision, `${label}.decision`, 32)
  if (!['match', 'create', 'dismiss', 'uncertain'].includes(decision)) throw new TypeError(`Invalid ${label}.decision.`)
  const confidence = finiteNumber(value.confidence, `${label}.confidence`, 0)
  if (confidence > 1) throw new TypeError(`Invalid ${label}.confidence.`)
  const reason = nonEmptyString(value.reason, `${label}.reason`, MAX_REASON_LENGTH)
  const parsed: ActionableReviewAiAdvice = { sourceRowId, decision: decision as ActionableReviewAiAdvice['decision'], confidence, reason }

  if (decision === 'match') {
    const catalogId = nonEmptyString(value.catalogId, `${label}.catalogId`, 256)
    const candidate = candidates.find((entry) => entry.catalogId === catalogId)
    if (!candidate) throw new TypeError(`Invalid ${label}.catalogId.`)
    if (value.proposedCatalogMetadata !== undefined) throw new TypeError(`Invalid ${label}.proposedCatalogMetadata.`)
    if (value.conversionRuleId !== undefined) {
      const ruleId = nonEmptyString(value.conversionRuleId, `${label}.conversionRuleId`, 256)
      if (candidate.conversionRuleId !== ruleId) throw new TypeError(`Invalid ${label}.conversionRuleId.`)
      parsed.conversionRuleId = ruleId
    } else if (candidate.conversionRuleId !== undefined) {
      throw new TypeError(`Invalid ${label}.conversionRuleId.`)
    }
    parsed.catalogId = catalogId
  } else if (decision === 'create') {
    if (value.catalogId !== undefined || value.conversionRuleId !== undefined) throw new TypeError(`Invalid ${label}.catalogId.`)
    if (value.proposedCatalogMetadata === undefined) throw new TypeError(`Invalid ${label}.proposedCatalogMetadata.`)
    parsed.proposedCatalogMetadata = parseProposedCatalogMetadata(value.proposedCatalogMetadata)
  } else {
    if (value.catalogId !== undefined || value.conversionRuleId !== undefined || value.proposedCatalogMetadata !== undefined) {
      throw new TypeError(`Invalid ${label} fields.`)
    }
  }
  return parsed
}

function parseSuggestionVersionsEqual(value: unknown, reviewVersions: SuggestionVersions, label: string): SuggestionVersions {
  const parsed = parseSuggestionVersions(value)
  for (const key of ['extractionFingerprint', 'boqSectionsFingerprint', 'catalogFingerprint', 'conversionFingerprint', 'promptVersion', 'modelVersion'] as const) {
    if (parsed[key] !== reviewVersions[key]) throw new TypeError(`Invalid ${label}: version mismatch.`)
  }
  return parsed
}

function parseSuggestion(value: unknown, review: { extractionRunId: string; versions: SuggestionVersions }, index: number): ActionableItemSuggestion {
  const label = `actionableItemSuggestions[${index}]`
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  exactKeys(value, [
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
  ], label)
  const id = nonEmptyString(value.id, `${label}.id`, 256)
  const extractionRunId = nonEmptyString(value.extractionRunId, `${label}.extractionRunId`, 256)
  if (extractionRunId !== review.extractionRunId) throw new TypeError(`Invalid ${label}.extractionRunId.`)
  if (!Array.isArray(value.sourceRowIds) || value.sourceRowIds.length === 0) throw new TypeError(`Invalid ${label}.sourceRowIds.`)
  const sourceRowIds = value.sourceRowIds.map((rowId, rowIndex) => nonEmptyString(rowId, `${label}.sourceRowIds[${rowIndex}]`, 256))
  if (new Set(sourceRowIds).size !== sourceRowIds.length) throw new TypeError(`Duplicate ${label}.sourceRowIds.`)
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length !== sourceRowIds.length) throw new TypeError(`Invalid ${label}.sourceRefs.`)
  const sourceRefs = value.sourceRefs.map((ref, refIndex) => parseSourceRef(ref, `${label}.sourceRefs[${refIndex}]`))
  const rowRole = parseRowRole(value.rowRole)
  if (rowRole !== 'priced_item' && rowRole !== 'uncertain') throw new TypeError(`Invalid ${label}.rowRole.`)
  if (!Array.isArray(value.deterministicReasons) || value.deterministicReasons.length === 0) throw new TypeError(`Invalid ${label}.deterministicReasons.`)
  const deterministicReasons = value.deterministicReasons.map((reason, reasonIndex) => nonEmptyString(reason, `${label}.deterministicReasons[${reasonIndex}]`, MAX_REASON_LENGTH))
  const suggestedSectionIndex = finiteInteger(value.suggestedSectionIndex, `${label}.suggestedSectionIndex`)
  const extractedItem = parseExtractedPricingSnapshot(value.extractedItem)
  if (!Array.isArray(value.catalogCandidates) || value.catalogCandidates.length > 3) throw new TypeError(`Invalid ${label}.catalogCandidates.`)
  const catalogCandidates = value.catalogCandidates.map((candidate, candidateIndex) => parseCandidate(candidate, `${label}.catalogCandidates[${candidateIndex}]`))
  if (new Set(catalogCandidates.map((candidate) => candidate.catalogId)).size !== catalogCandidates.length) throw new TypeError(`Duplicate ${label}.catalogCandidates.`)
  const sourceRowSet = new Set(sourceRowIds)
  const aiAdvice = value.aiAdvice === undefined
    ? undefined
    : parseAdvice(value.aiAdvice, sourceRowSet, catalogCandidates, `${label}.aiAdvice`)
  const normalization = value.normalization === undefined
    ? undefined
    : parsePricingNormalization(value.normalization)
  if (normalization) {
    const candidate = catalogCandidates.find((entry) => entry.catalogId === normalization.catalogId)
    if (!candidate) throw new TypeError(`Invalid ${label}.normalization.`)
  }
  const status = nonEmptyString(value.status, `${label}.status`, 64)
  if (!ACTIONABLE_STATUS_SET.has(status)) throw new TypeError(`Invalid ${label}.status.`)
  const versions = parseSuggestionVersionsEqual(value.versions, review.versions, `${label}.versions`)
  const parsed: ActionableItemSuggestion = {
    id,
    extractionRunId,
    sourceRowIds,
    sourceRefs,
    rowRole,
    deterministicReasons,
    suggestedSectionIndex,
    extractedItem,
    catalogCandidates,
    status: status as ActionableSuggestionStatus,
    versions,
  }
  if (value.sourceCellMapping !== undefined) {
    parsed.sourceCellMapping = parseSourceCellMapping(value.sourceCellMapping, sourceRowSet)
  }
  if (aiAdvice !== undefined) parsed.aiAdvice = aiAdvice
  if (normalization !== undefined) parsed.normalization = normalization
  return parsed
}

function parseDismissedEvidence(value: unknown, index: number): RowRoleFinding {
  const label = `dismissedEvidence[${index}]`
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  requireKeys(value, ['sourceRowId', 'role', 'reasonCodes', 'deterministic', 'sourceRef'], label)
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length === 0) throw new TypeError(`Invalid ${label}.reasonCodes.`)
  return {
    sourceRowId: nonEmptyString(value.sourceRowId, `${label}.sourceRowId`, 256),
    role: parseRowRole(value.role),
    reasonCodes: value.reasonCodes.map((reason, reasonIndex) => nonEmptyString(reason, `${label}.reasonCodes[${reasonIndex}]`, MAX_REASON_LENGTH)),
    deterministic: value.deterministic === true || value.deterministic === false ? value.deterministic : (() => { throw new TypeError(`Invalid ${label}.deterministic.`) })(),
    sourceRef: parseSourceRef(value.sourceRef, `${label}.sourceRef`),
  }
}

function parseRepresentedRow(value: unknown, index: number): RepresentedRowFinding {
  const label = `representedRows[${index}]`
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  requireKeys(value, ['sourceRowIds', 'boqItemId', 'reason', 'sourceRefs'], label)
  if (!Array.isArray(value.sourceRowIds) || value.sourceRowIds.length === 0) throw new TypeError(`Invalid ${label}.sourceRowIds.`)
  const sourceRowIds = value.sourceRowIds.map((rowId, rowIndex) => nonEmptyString(rowId, `${label}.sourceRowIds[${rowIndex}]`, 256))
  if (new Set(sourceRowIds).size !== sourceRowIds.length) throw new TypeError(`Duplicate ${label}.sourceRowIds.`)
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length !== sourceRowIds.length) throw new TypeError(`Invalid ${label}.sourceRefs.`)
  const reason = nonEmptyString(value.reason, `${label}.reason`, 64)
  if (!REPRESENTED_REASONS.has(reason)) throw new TypeError(`Invalid ${label}.reason.`)
  return {
    sourceRowIds,
    boqItemId: nonEmptyString(value.boqItemId, `${label}.boqItemId`, 256),
    reason: reason as RepresentedRowFinding['reason'],
    sourceRefs: value.sourceRefs.map((ref, refIndex) => parseSourceRef(ref, `${label}.sourceRefs[${refIndex}]`)),
  }
}

function parseValidationSummary(value: unknown): ActionableReviewValidationSummary {
  const label = 'validationSummary'
  if (!isPlainRecord(value)) throw new TypeError(`Invalid ${label}.`)
  requireKeys(value, [
    'rawRowCount',
    'actionableCount',
    'dismissedCount',
    'representedCount',
    'locallyPreparedCatalogCount',
    'aiReviewedCount',
    'sourceTotalDifference',
    'rejectedReasonCounts',
  ], label)
  const counts = ['rawRowCount', 'actionableCount', 'dismissedCount', 'representedCount', 'locallyPreparedCatalogCount', 'aiReviewedCount'] as const
  const parsedCounts = Object.fromEntries(counts.map((key) => [key, finiteInteger(value[key], `${label}.${key}`)])) as Record<typeof counts[number], number>
  let sourceTotalDifference: DecimalString | null = null
  if (value.sourceTotalDifference !== null && value.sourceTotalDifference !== undefined) {
    sourceTotalDifference = canonicalDecimal(value.sourceTotalDifference, `${label}.sourceTotalDifference`)
  }
  if (!isPlainRecord(value.rejectedReasonCounts)) throw new TypeError(`Invalid ${label}.rejectedReasonCounts.`)
  const rejectedReasonCounts: Record<string, number> = {}
  for (const [reason, count] of Object.entries(value.rejectedReasonCounts)) {
    if (reason.trim() === '') throw new TypeError(`Invalid ${label}.rejectedReasonCounts.`)
    rejectedReasonCounts[reason] = finiteInteger(count, `${label}.rejectedReasonCounts.${reason}`)
  }
  return {
    ...parsedCounts,
    sourceTotalDifference,
    rejectedReasonCounts,
  }
}

function parseReview(value: unknown): ActionableReview {
  if (!isPlainRecord(value)) throw new TypeError('Invalid actionable review response.')
  requireKeys(value, [
    'id',
    'extractionRunId',
    'actionableItemSuggestions',
    'dismissedEvidence',
    'representedRows',
    'validationSummary',
    'versions',
    'generatedAt',
    'mode',
  ], 'actionable review')
  const id = parseHash(value.id, 'review.id')
  const extractionRunId = nonEmptyString(value.extractionRunId, 'review.extractionRunId', 256)
  const generatedAt = nonEmptyString(value.generatedAt, 'review.generatedAt', 128)
  if (Number.isNaN(Date.parse(generatedAt))) throw new TypeError('Invalid review.generatedAt.')
  const mode = nonEmptyString(value.mode, 'review.mode', 32)
  if (!REVIEW_MODES.has(mode)) throw new TypeError('Invalid review.mode.')
  const versions = parseSuggestionVersions(value.versions)
  if (!Array.isArray(value.actionableItemSuggestions)) throw new TypeError('Invalid actionableItemSuggestions.')
  const actionableItemSuggestions = value.actionableItemSuggestions.map((suggestion, index) => parseSuggestion(suggestion, { extractionRunId, versions }, index))
  if (new Set(actionableItemSuggestions.map((suggestion) => suggestion.id)).size !== actionableItemSuggestions.length) throw new TypeError('Duplicate suggestion ids.')
  const dismissedEvidence = Array.isArray(value.dismissedEvidence)
    ? value.dismissedEvidence.map((finding, index) => parseDismissedEvidence(finding, index))
    : (() => { throw new TypeError('Invalid dismissedEvidence.') })()
  const representedRows = Array.isArray(value.representedRows)
    ? value.representedRows.map((finding, index) => parseRepresentedRow(finding, index))
    : (() => { throw new TypeError('Invalid representedRows.') })()
  const seenSourceRows = new Set<string>()
  for (const rowId of actionableItemSuggestions.flatMap((suggestion) => suggestion.sourceRowIds)) {
    if (seenSourceRows.has(rowId)) throw new TypeError('Duplicate source row ids.')
    seenSourceRows.add(rowId)
  }
  for (const finding of dismissedEvidence) {
    if (seenSourceRows.has(finding.sourceRowId)) throw new TypeError('Duplicate source row ids.')
    seenSourceRows.add(finding.sourceRowId)
  }
  for (const finding of representedRows) {
    for (const rowId of finding.sourceRowIds) {
      if (seenSourceRows.has(rowId)) throw new TypeError('Duplicate source row ids.')
      seenSourceRows.add(rowId)
    }
  }
  return {
    id,
    extractionRunId,
    actionableItemSuggestions,
    dismissedEvidence,
    representedRows,
    validationSummary: parseValidationSummary(value.validationSummary),
    versions,
    generatedAt,
    mode: mode as ActionableReview['mode'],
  }
}

export function normalizeActionableReviewResponse(value: unknown): ActionableReview | null {
  try {
    return parseReview(value)
  } catch {
    return null
  }
}

export function initialActionableReviewState(): ActionableReviewState {
  return {
    snapshot: null,
    selectedSuggestionId: null,
    auditOpen: false,
    loading: false,
    submittingSuggestionId: null,
    error: null,
  }
}

export function actionableReviewReducer(
  state: ActionableReviewState,
  action: ActionableReviewAction,
): ActionableReviewState {
  switch (action.type) {
    case 'load_started':
      return { ...state, loading: true, submittingSuggestionId: null, error: null }
    case 'load_succeeded': {
      const selectedSuggestionId = action.snapshot.actionableItemSuggestions.some(
        (suggestion) => suggestion.id === state.selectedSuggestionId,
      ) ? state.selectedSuggestionId : null
      return { ...state, snapshot: action.snapshot, selectedSuggestionId, loading: false, error: null }
    }
    case 'load_failed':
      return { ...state, loading: false, error: action.error }
    case 'requests_cancelled':
      return { ...state, loading: false, submittingSuggestionId: null }
    case 'decision_started':
      return { ...state, loading: false, submittingSuggestionId: action.suggestionId, error: null }
    case 'decision_succeeded':
      return { ...state, submittingSuggestionId: null, error: null }
    case 'decision_failed':
      return { ...state, submittingSuggestionId: null, error: action.error }
    case 'select_suggestion':
      return { ...state, selectedSuggestionId: action.suggestionId }
    case 'toggle_audit':
      return { ...state, auditOpen: !state.auditOpen }
    case 'clear_error':
      return { ...state, error: null }
    default:
      return state
  }
}

export interface ActionableReviewRequestGeneration {
  current: number
}

export function createActionableReviewRequestGeneration(): ActionableReviewRequestGeneration {
  return { current: 0 }
}

export function beginActionableReviewRequest(generation: ActionableReviewRequestGeneration): number {
  generation.current += 1
  return generation.current
}

export function isLatestActionableReviewRequest(
  generation: ActionableReviewRequestGeneration,
  requestGeneration: number,
): boolean {
  return generation.current === requestGeneration
}

export function invalidateActionableReviewRequests(generation: ActionableReviewRequestGeneration): void {
  generation.current += 1
}

export function isActionableReviewStale(
  snapshot: ActionableReview | null,
  expectedScope: ActionableReviewVersionScope | null,
): boolean {
  if (!snapshot || !expectedScope) return true
  return snapshot.versions.extractionFingerprint !== expectedScope.extractionFingerprint
    || snapshot.versions.boqSectionsFingerprint !== expectedScope.boqSectionsFingerprint
    || snapshot.versions.catalogFingerprint !== expectedScope.catalogFingerprint
    || snapshot.versions.conversionFingerprint !== expectedScope.conversionFingerprint
}

export function canMutateActionableReview(
  snapshot: ActionableReview | null,
  expectedScope: ActionableReviewVersionScope | null,
  readOnly: boolean,
): boolean {
  return !readOnly && !isActionableReviewStale(snapshot, expectedScope)
}

export function isSuggestionMutable(
  snapshot: ActionableReview | null,
  suggestionId: string,
  expectedScope: ActionableReviewVersionScope | null,
  readOnly: boolean,
): boolean {
  if (!canMutateActionableReview(snapshot, expectedScope, readOnly)) return false
  return snapshot?.actionableItemSuggestions.some(
    (suggestion) => suggestion.id === suggestionId && suggestion.status === 'pending',
  ) ?? false
}
