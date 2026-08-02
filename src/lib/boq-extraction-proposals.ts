import { createHash } from 'node:crypto'
import { deriveSourceCostAllocation } from './boq-cost-allocation'
import { BOQ_RECONCILIATION_TOLERANCE, type BoqSourceRowV3 } from './boq-extraction-schema'
import { stableCanonicalJson } from './boq-extraction-run'
import type { BoqItem, BoqPricedItem, BoqSection, BoqSourceRef } from './boq-schema'
import type { ExtractionCandidateItem } from './boq-extraction-evidence'
import type { SourceBackedReviewDraft, SourceCellMapping } from './boq-extraction-cell-mapping'

export const PROPOSAL_OPERATIONS = [
  'keep', 'split', 'merge', 'separate_components', 'create_bundle', 'needs_human_review',
  'insert_missing_item', 'replace_item', 'remove_spurious_item',
] as const

/** New reviews may only create these mutating decisions. Legacy operations
 * remain readable for stored audit compatibility. */
export const REVIEW_ACTIONABLE_OPERATIONS = new Set<ProposalOperation>([
  'insert_missing_item', 'replace_item', 'remove_spurious_item',
])

export function isReviewActionableOperation(operation: unknown): operation is ProposalOperation {
  return typeof operation === 'string' && REVIEW_ACTIONABLE_OPERATIONS.has(operation as ProposalOperation)
}

/** Operations that require at least one existing target item. */
const OPERATIONS_REQUIRING_TARGETS = new Set<ProposalOperation>([
  'keep', 'split', 'merge', 'separate_components', 'create_bundle',
  'replace_item', 'remove_spurious_item',
])

const PRICING_ROLES = new Set(['standard', 'bundle_parent', 'bundle_child'])
const COST_COMPONENTS = new Set(['material', 'labour', 'combined', 'lump_sum'])

export type ProposalOperation = typeof PROPOSAL_OPERATIONS[number]
export type ProposalCostComponent = 'material' | 'labour' | 'combined' | 'lump_sum'
export const PROPOSAL_VALIDATION_FAILURE_CODES = [
  'invalid_shape',
  'unknown_operation',
  'invalid_confidence',
  'run_identity_mismatch',
  'unknown_source_row',
  'missing_source_evidence',
  'unknown_target_item',
  'duplicate_item_id',
  'duplicate_source_row',
  'source_provenance_mismatch',
  'target_source_mismatch',
  'arithmetic_mismatch',
  'reconciliation_mismatch',
  'invented_component_price',
  'invalid_bundle',
  'invalid_operation_shape',
  'stale_item',
  'target_state_mismatch',
  'overlapping_target',
  'overlapping_source_row',
  'duplicate_proposal',
  'unknown_candidate_item',
  'duplicate_canonical_source',
  'spurious_removal_blocked',
] as const

export type ProposalValidationFailureCode = (typeof PROPOSAL_VALIDATION_FAILURE_CODES)[number]

const FAILURE_CODE_SET = new Set<string>(PROPOSAL_VALIDATION_FAILURE_CODES)

export function isProposalValidationFailureCode(value: unknown): value is ProposalValidationFailureCode {
  return typeof value === 'string' && FAILURE_CODE_SET.has(value)
}

/** Safe, server-owned summary of proposal validation results. Contains only
 *  nonnegative integer counts and allowlisted failure-code counts — never
 *  raw provider output, source text, indices, or explanations. */
export interface ProposalValidationSummary {
  validatedProposalCount: number
  rejectedProposalCount: number
  rejectionCounts?: Partial<Record<ProposalValidationFailureCode, number>>
}

/** Sanitizes untrusted stored/API summary data. Returns null when the field is
 *  absent or malformed so otherwise valid proposals remain readable. */
export function normalizeValidationSummary(value: unknown): ProposalValidationSummary | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) return null
  const validated = value.validatedProposalCount
  const rejected = value.rejectedProposalCount
  if (typeof validated !== 'number' || !Number.isInteger(validated) || validated < 0) return null
  if (typeof rejected !== 'number' || !Number.isInteger(rejected) || rejected < 0) return null
  const rawCounts = value.rejectionCounts
  const rejectionCounts: Partial<Record<ProposalValidationFailureCode, number>> = {}
  let codeSum = 0
  if (rawCounts !== undefined && rawCounts !== null) {
    if (!isRecord(rawCounts)) return null
    for (const [code, count] of Object.entries(rawCounts)) {
      if (!isProposalValidationFailureCode(code)) return null
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null
      rejectionCounts[code] = count
      codeSum += count
    }
  }
  if (codeSum > rejected) return null
  return { validatedProposalCount: validated, rejectedProposalCount: rejected, ...(codeSum > 0 ? { rejectionCounts } : {}) }
}

export interface ProposalSourceComponentEvidence {
  qty: number
  unit: string
  rate: number
  total: number
}

export interface ProposalSourceEvidence {
  quotedTotal: number
  components?: {
    material: ProposalSourceComponentEvidence
    labour: ProposalSourceComponentEvidence
  }
}

export interface ProposalPricedItem {
  id: string
  desc: string
  pricingRole: 'standard' | 'bundle_parent'
  parentBundleId?: null
  sourceRowIds: string[]
  sourceRef?: BoqSourceRef
  entryOrigin: 'ai_accepted'
  optional?: boolean
  excludedFromTotal?: boolean
  exclusionReason?: string | null
  unit: string
  qty: number
  rate: number
  total: number
  costComponent: ProposalCostComponent
  sourceCosts?: { material: ProposalSourceComponentEvidence; labour: ProposalSourceComponentEvidence } | null
}

export interface ProposalBundleChild {
  id: string
  desc: string
  pricingRole: 'bundle_child'
  parentBundleId: string
  sourceRowIds: string[]
  sourceRef?: BoqSourceRef
  entryOrigin: 'ai_accepted'
  optional?: boolean
  excludedFromTotal?: boolean
  exclusionReason?: string | null
}

export type ProposedExtractionItem = ProposalPricedItem | ProposalBundleChild

export interface ExtractionProposal {
  id: string
  extractionRunId: string
  operation: ProposalOperation
  /** Present on v2 decisions. Candidate IDs are selected by the provider;
   * all other fields below are injected and verified by the server. */
  candidateItemIds?: string[]
  baseSectionsFingerprint?: string
  destinationSectionIndex?: number
  destinationItemIndex?: number
  candidateSourceOrder?: number
  sourceRowIds: string[]
  targetItemIds: string[]
  affectedItemFingerprints: Record<string, string>
  confidence: number
  explanation: string
  proposedItems: ProposedExtractionItem[]
  /** Server-resolved coordinates into immutable Docling cells. Never model-authored values. */
  sourceCellMapping?: SourceCellMapping
  /** Review-time reconstruction snapshot. Acceptance must reconstruct and compare it byte-for-byte. */
  mappedCandidate?: ExtractionCandidateItem
  /** Source-backed partial resolution for a non-actionable human-review decision. */
  reviewDraft?: SourceBackedReviewDraft
}

/** Server-owned immutable candidate used to validate expanded v2 decisions. */
export interface ProposalCandidateRef {
  id: string
  sectionIndex: number
  sectionHeader: string
  sourceOrder: number
  sourceRowIds: string[]
  sourceRefs?: BoqSourceRef[]
  desc: string
  pricingRole: 'standard' | 'bundle_parent'
  parentBundleId: null
  unit: string
  qty: number
  rate: number
  total: number
  costComponent: ProposalCostComponent | string
  sourceCosts?: { material: ProposalSourceComponentEvidence; labour: ProposalSourceComponentEvidence } | null
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason: string | null
}

export type ProposalValidationSourceRow = Pick<BoqSourceRowV3, 'id'> & Partial<Omit<BoqSourceRowV3, 'id'>>

export interface ProposalValidationContext {
  extractionRunId: string
  sourceRows: ReadonlyArray<ProposalValidationSourceRow>
  sourceEvidence: Readonly<Record<string, ProposalSourceEvidence>>
  sections: readonly BoqSection[]
  /** Server-owned candidate items from the immutable extraction run.
   *  Required for every v2 mutating decision. */
  candidateItems?: ReadonlyMap<string, ProposalCandidateRef>
}

export interface ValidatedProposal extends ExtractionProposal {
  evidenceValid: true
  reconciled: true
  stale: boolean
}

export type ProposalValidationResult =
  | { valid: true; proposal: ValidatedProposal }
  | { valid: false; code: ProposalValidationFailureCode }

export interface ProposalBatchValidationResult {
  valid: boolean
  results: ProposalValidationResult[]
}

export interface ProposalAcceptanceAudit {
  proposalId: string
  operation: ProposalOperation
  beforeSections: BoqSection[]
  beforeSectionsFingerprint: string
  afterSectionsFingerprint: string
}

export class ProposalUndoConflictError extends Error {
  constructor() {
    super('Cannot undo this proposal because the BOQ changed after acceptance')
    this.name = 'ProposalUndoConflictError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= BOQ_RECONCILIATION_TOLERANCE
}

function hasUniqueStrings(values: unknown): values is string[] {
  return Array.isArray(values) && values.every(nonBlankString) && new Set(values).size === values.length
}

function validOptionalState(item: Record<string, unknown>): boolean {
  if (item.optional !== undefined && typeof item.optional !== 'boolean') return false
  if (item.excludedFromTotal !== undefined && typeof item.excludedFromTotal !== 'boolean') return false
  if (item.exclusionReason !== undefined && item.exclusionReason !== null && typeof item.exclusionReason !== 'string') return false
  const excluded = item.excludedFromTotal === true
  const optional = item.optional === true
  const reason = item.exclusionReason
  if (excluded && (!optional || typeof reason !== 'string' || reason.trim() === '')) return false
  if (!excluded && reason !== undefined && reason !== null) return false
  return true
}

const SOURCE_MAPPING_KEYS = new Set([
  'sourceRowIds', 'description', 'unit', 'quantity', 'rate', 'total',
  'materialRate', 'materialTotal', 'labourRate', 'labourTotal', 'amount',
])
const SOURCE_REF_KEYS = new Set(['sourceRowId', 'column', 'line'])
const REVIEW_DRAFT_KEYS = new Set(['mapping', 'resolvedValues', 'missingFields', 'sourceRowIds', 'sourceRefs', 'section'])
const RESOLVED_VALUE_KEYS = new Set([
  'description', 'unit', 'quantity', 'rate', 'total',
  'materialRate', 'materialTotal', 'labourRate', 'labourTotal', 'amount',
])
const REVIEW_MISSING_FIELDS = new Set([...RESOLVED_VALUE_KEYS, 'destinationSection', 'targetItemState'])

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function validSourceCellRef(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, SOURCE_REF_KEYS)
    && nonBlankString(value.sourceRowId) && Number.isInteger(value.column) && (value.column as number) >= 0
    && (value.line === undefined || Number.isInteger(value.line) && (value.line as number) >= 0)
}

function validSourceCellMapping(value: unknown, proposalSourceRowIds: readonly string[]): value is SourceCellMapping {
  if (!isRecord(value) || !exactKeys(value, SOURCE_MAPPING_KEYS) || !hasUniqueStrings(value.sourceRowIds)
    || value.sourceRowIds.length === 0
    || stableCanonicalJson(value.sourceRowIds) !== stableCanonicalJson(proposalSourceRowIds)) return false
  if (value.description !== undefined && (!Array.isArray(value.description) || value.description.length === 0
    || !value.description.every(validSourceCellRef))) return false
  for (const key of [...SOURCE_MAPPING_KEYS].filter((entry) => entry !== 'sourceRowIds' && entry !== 'description')) {
    if (value[key] !== undefined && !validSourceCellRef(value[key])) return false
  }
  const refs = [
    ...(Array.isArray(value.description) ? value.description : []),
    ...[...SOURCE_MAPPING_KEYS].filter((key) => key !== 'sourceRowIds' && key !== 'description')
      .flatMap((key) => value[key] === undefined ? [] : [value[key]]),
  ] as Array<{ sourceRowId: string }>
  const boundSourceRowIds = new Set(refs.map((ref) => ref.sourceRowId))
  return refs.every((ref) => proposalSourceRowIds.includes(ref.sourceRowId))
    && boundSourceRowIds.size === proposalSourceRowIds.length
    && proposalSourceRowIds.every((id) => boundSourceRowIds.has(id))
}

const MAPPED_CANDIDATE_KEYS = new Set([
  'id', 'sectionIndex', 'sectionHeader', 'sourceOrder', 'sourceRowIds', 'sourceRefs',
  'desc', 'pricingRole', 'parentBundleId', 'unit', 'qty', 'rate', 'total',
  'costComponent', 'sourceCosts', 'optional', 'excludedFromTotal', 'exclusionReason',
])
const SOURCE_LOCATION_KEYS = new Set(['page', 'table', 'row'])
const STORED_PROPOSAL_KEYS = new Set([
  'id', 'extractionRunId', 'operation', 'candidateItemIds', 'baseSectionsFingerprint',
  'destinationSectionIndex', 'destinationItemIndex', 'candidateSourceOrder',
  'sourceRowIds', 'targetItemIds', 'affectedItemFingerprints', 'confidence',
  'explanation', 'proposedItems', 'sourceCellMapping', 'mappedCandidate', 'reviewDraft',
  'evidenceValid', 'reconciled', 'stale',
])

function validMappedCandidate(value: unknown, proposalSourceRowIds: readonly string[]): value is ExtractionCandidateItem {
  return isRecord(value) && exactKeys(value, MAPPED_CANDIDATE_KEYS)
    && nonBlankString(value.id)
    && Number.isInteger(value.sectionIndex) && (value.sectionIndex as number) >= 0
    && nonBlankString(value.sectionHeader)
    && Number.isInteger(value.sourceOrder) && (value.sourceOrder as number) >= 0
    && hasUniqueStrings(value.sourceRowIds)
    && stableCanonicalJson(value.sourceRowIds) === stableCanonicalJson(proposalSourceRowIds)
    && Array.isArray(value.sourceRefs) && value.sourceRefs.length === value.sourceRowIds.length
    && value.sourceRefs.every((ref) => isRecord(ref) && exactKeys(ref, SOURCE_LOCATION_KEYS)
      && Number.isInteger(ref.page) && (ref.page as number) >= 0
      && Number.isInteger(ref.table) && (ref.table as number) >= 0
      && Number.isInteger(ref.row) && (ref.row as number) >= 0)
    && nonBlankString(value.desc)
    && value.pricingRole === 'standard' && value.parentBundleId === null
    && nonBlankString(value.unit)
    && finiteNonNegative(value.qty) && finiteNonNegative(value.rate) && finiteNonNegative(value.total)
    && approximatelyEqual(value.qty * value.rate, value.total)
    && COST_COMPONENTS.has(value.costComponent as string)
    && validSourceCosts(value.sourceCosts, value.total)
    && typeof value.optional === 'boolean'
    && typeof value.excludedFromTotal === 'boolean'
    && validOptionalState(value)
}

function validReviewDraft(value: unknown, proposalSourceRowIds: readonly string[]): value is SourceBackedReviewDraft {
  if (!isRecord(value) || !exactKeys(value, REVIEW_DRAFT_KEYS)
    || !validSourceCellMapping(value.mapping, proposalSourceRowIds)
    || !isRecord(value.resolvedValues) || !exactKeys(value.resolvedValues, RESOLVED_VALUE_KEYS)
    || !Array.isArray(value.missingFields) || value.missingFields.length === 0
    || !value.missingFields.every((field) => typeof field === 'string' && REVIEW_MISSING_FIELDS.has(field))
    || new Set(value.missingFields).size !== value.missingFields.length
    || !hasUniqueStrings(value.sourceRowIds)
    || stableCanonicalJson(value.sourceRowIds) !== stableCanonicalJson(proposalSourceRowIds)
    || !Array.isArray(value.sourceRefs)
    || !value.sourceRefs.every((ref) => isRecord(ref) && exactKeys(ref, new Set(['page', 'table', 'row']))
      && Number.isInteger(ref.page) && Number.isInteger(ref.table) && Number.isInteger(ref.row))
  ) return false
  if (value.section !== null && (!isRecord(value.section) || !Number.isInteger(value.section.index)
    || (value.section.index as number) < 0 || !nonBlankString(value.section.header))) return false
  return Object.entries(value.resolvedValues).every(([key, entry]) => {
    if (key === 'description' || key === 'unit') return nonBlankString(entry)
    return finiteNonNegative(entry)
  })
}

function validateSourceBackedMetadata(proposal: ExtractionProposal): ProposalValidationResult | null {
  const hasMapping = proposal.sourceCellMapping !== undefined
  const hasCandidate = proposal.mappedCandidate !== undefined
  const hasDraft = proposal.reviewDraft !== undefined
  if (hasMapping !== hasCandidate) return fail('invalid_operation_shape')
  if (hasDraft) {
    if (proposal.operation !== 'needs_human_review' || hasMapping
      || !validReviewDraft(proposal.reviewDraft, proposal.sourceRowIds)) return fail('invalid_operation_shape')
  }
  if (hasMapping) {
    if (!['insert_missing_item', 'replace_item'].includes(proposal.operation)
      || !validSourceCellMapping(proposal.sourceCellMapping, proposal.sourceRowIds)
      || !validMappedCandidate(proposal.mappedCandidate, proposal.sourceRowIds)) {
      return fail('invalid_operation_shape')
    }
  }
  return null
}

/** Context-free Firestore/API decoder. Immutable evidence and canonical target
 * checks still belong to validateExtractionProposal, but malformed proposal
 * records must never be exposed to review clients. */
export function isStructurallyValidExtractionProposal(value: unknown): value is ExtractionProposal {
  if (!isRecord(value)
    || !exactKeys(value, STORED_PROPOSAL_KEYS)
    || !nonBlankString(value.id)
    || !nonBlankString(value.extractionRunId)
    || !PROPOSAL_OPERATIONS.includes(value.operation as ProposalOperation)
    || !hasUniqueStrings(value.sourceRowIds) || value.sourceRowIds.length === 0
    || !hasUniqueStrings(value.targetItemIds)
    || !isRecord(value.affectedItemFingerprints)
    || !Object.values(value.affectedItemFingerprints).every((fingerprint) => typeof fingerprint === 'string')
    || !finiteNonNegative(value.confidence) || value.confidence > 1
    || !nonBlankString(value.explanation)
    || !Array.isArray(value.proposedItems)
  ) return false
  const proposal = value as unknown as ExtractionProposal
  for (const marker of ['evidenceValid', 'reconciled', 'stale'] as const) {
    if (value[marker] !== undefined && typeof value[marker] !== 'boolean') return false
  }
  if (proposal.candidateItemIds !== undefined && !hasUniqueStrings(proposal.candidateItemIds)) return false
  if (proposal.baseSectionsFingerprint !== undefined && !nonBlankString(proposal.baseSectionsFingerprint)) return false
  for (const index of [proposal.destinationSectionIndex, proposal.destinationItemIndex, proposal.candidateSourceOrder]) {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) return false
  }
  if (!proposal.proposedItems.every((item) => validProposedItem(item, proposal.sourceRowIds))) return false
  return validateSourceBackedMetadata(proposal) === null
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableCanonicalJson(value)).digest('hex')}`
}

export function fingerprintCanonicalItem(item: BoqItem): string {
  return digest(item)
}

export function fingerprintCanonicalSections(sections: readonly BoqSection[]): string {
  return digest(sections)
}

function fail(code: ProposalValidationFailureCode): ProposalValidationResult {
  return { valid: false, code }
}

function knownItems(sections: readonly BoqSection[]): Map<string, BoqItem> {
  const items = new Map<string, BoqItem>()
  for (const section of sections) {
    for (const item of section.items) if (nonBlankString(item.id)) items.set(item.id, item)
  }
  return items
}

/** Returns the canonical source-row IDs a target item was derived from.
 *  Prefers the explicit `sourceRowIds` array; falls back to legacy `sourceRowId`. */
function canonicalTargetSourceRows(item: BoqItem): string[] {
  if (Array.isArray(item.sourceRowIds) && item.sourceRowIds.length > 0) {
    const filtered = item.sourceRowIds.filter(nonBlankString)
    if (filtered.length > 0) return filtered
  }
  if (nonBlankString(item.sourceRowId)) return [item.sourceRowId]
  return []
}

function quotedTotal(sourceRowIds: readonly string[], context: ProposalValidationContext): number | null {
  let sum = 0
  for (const sourceRowId of sourceRowIds) {
    const evidence = context.sourceEvidence[sourceRowId]
    if (!evidence || !Object.prototype.hasOwnProperty.call(evidence, 'quotedTotal') || !finiteNonNegative(evidence.quotedTotal)) return null
    sum += evidence.quotedTotal
  }
  return Number.isFinite(sum) ? sum : null
}

function hasValidComponent(component: unknown): component is ProposalSourceComponentEvidence {
  return isRecord(component)
    && finiteNonNegative(component.qty)
    && nonBlankString(component.unit)
    && finiteNonNegative(component.rate)
    && finiteNonNegative(component.total)
    && approximatelyEqual(component.qty * component.rate, component.total)
}

function validSourceCosts(value: unknown, expectedTotal: number): boolean {
  if (value === undefined || value === null) return value === null || value === undefined
  if (!isRecord(value) || !hasValidComponent(value.material) || !hasValidComponent(value.labour)) return false
  return approximatelyEqual(value.material.total + value.labour.total, expectedTotal)
}

function validProposedItem(
  item: unknown,
  proposalSourceRowIds: readonly string[],
): item is ProposedExtractionItem {
  if (!isRecord(item)
    || !nonBlankString(item.id)
    || !nonBlankString(item.desc)
    || !PRICING_ROLES.has(item.pricingRole as string)
    || !hasUniqueStrings(item.sourceRowIds)
    || item.sourceRowIds.length === 0
    || item.sourceRowIds.some((sourceRowId) => !proposalSourceRowIds.includes(sourceRowId))
    || item.entryOrigin !== 'ai_accepted'
    || !validOptionalState(item)
  ) return false

  if (item.pricingRole === 'bundle_child') {
    if (item.optional === true || item.excludedFromTotal === true || item.exclusionReason !== undefined && item.exclusionReason !== null) return false
    return nonBlankString(item.parentBundleId)
      && !('unit' in item) && !('qty' in item) && !('rate' in item) && !('total' in item) && !('costComponent' in item)
  }
  return (item.pricingRole === 'standard' || item.pricingRole === 'bundle_parent')
    && (item.parentBundleId === undefined || item.parentBundleId === null)
    && nonBlankString(item.unit)
    && finiteNonNegative(item.qty)
    && finiteNonNegative(item.rate)
    && finiteNonNegative(item.total)
    && COST_COMPONENTS.has(item.costComponent as string)
    && approximatelyEqual(item.qty * item.rate, item.total)
    && validSourceCosts(item.sourceCosts, item.total)
}

function everyPriced(items: readonly ProposedExtractionItem[]): items is ProposalPricedItem[] {
  return items.every((item) => item.pricingRole !== 'bundle_child')
}

function totals(items: readonly ProposalPricedItem[]): number {
  return items.reduce((sum, item) => sum + item.total, 0)
}

function normalizedCandidateItem(candidate: ProposalCandidateRef): ProposalPricedItem {
  return {
    id: candidate.id,
    desc: candidate.desc,
    pricingRole: candidate.pricingRole,
    parentBundleId: null,
    sourceRowIds: [...candidate.sourceRowIds],
    ...(candidate.sourceRefs?.[0] ? { sourceRef: { ...candidate.sourceRefs[0] } } : {}),
    entryOrigin: 'ai_accepted',
    optional: candidate.optional,
    excludedFromTotal: candidate.excludedFromTotal,
    exclusionReason: candidate.exclusionReason,
    unit: candidate.unit,
    qty: candidate.qty,
    rate: candidate.rate,
    total: candidate.total,
    costComponent: candidate.costComponent as ProposalCostComponent,
    ...(candidate.sourceCosts ? { sourceCosts: structuredClone(candidate.sourceCosts) } : {}),
  }
}

function resolveCandidateSectionIndex(candidates: readonly ProposalCandidateRef[], sections: readonly BoqSection[]): number | null {
  const runIndexes = new Set(candidates.map((candidate) => candidate.sectionIndex))
  const headers = new Set(candidates.map((candidate) => candidate.sectionHeader))
  if (runIndexes.size !== 1 || headers.size !== 1) return null
  const runIndex = candidates[0].sectionIndex
  const header = candidates[0].sectionHeader
  if (sections[runIndex]?.header === header) return runIndex
  const matches = sections.flatMap((section, index) => section.header === header ? [index] : [])
  return matches.length === 1 ? matches[0] : null
}

function canonicalItemSourceOrder(item: BoqItem, candidates: ReadonlyMap<string, ProposalCandidateRef>): number {
  const sources = new Set(canonicalTargetSourceRows(item))
  let order = Number.MAX_SAFE_INTEGER
  for (const candidate of candidates.values()) {
    if (candidate.sourceRowIds.some((id) => sources.has(id))) order = Math.min(order, candidate.sourceOrder)
  }
  return order
}

function expectedDestinationItemIndex(
  proposal: ExtractionProposal,
  candidates: readonly ProposalCandidateRef[],
  context: ProposalValidationContext,
  sectionIndex: number,
): number | null {
  if (proposal.operation === 'replace_item') {
    const targetIds = new Set(proposal.targetItemIds)
    const indexes = context.sections[sectionIndex].items.flatMap((item, index) => targetIds.has(item.id ?? '') ? [index] : [])
    return indexes.length === proposal.targetItemIds.length ? Math.min(...indexes) : null
  }
  const firstOrder = Math.min(...candidates.map((candidate) => candidate.sourceOrder))
  const index = context.sections[sectionIndex].items.findIndex((item) =>
    canonicalItemSourceOrder(item, context.candidateItems!) > firstOrder)
  return index === -1 ? context.sections[sectionIndex].items.length : index
}

function validateCandidateExpansion(
  proposal: ExtractionProposal,
  context: ProposalValidationContext,
): ProposalValidationResult | null {
  if (!['insert_missing_item', 'replace_item'].includes(proposal.operation)) return null
  if (!context.candidateItems || !hasUniqueStrings(proposal.candidateItemIds) || proposal.candidateItemIds.length === 0) {
    return fail('unknown_candidate_item')
  }
  const candidates = proposal.candidateItemIds.map((id) => context.candidateItems!.get(id))
  if (candidates.some((candidate) => !candidate)) return fail('unknown_candidate_item')
  const knownCandidates = candidates as ProposalCandidateRef[]
  const canonicalItems = knownItems(context.sections)
  if (knownCandidates.some((candidate) => canonicalItems.has(candidate.id) && !proposal.targetItemIds.includes(candidate.id))) {
    return fail('duplicate_item_id')
  }
  const candidateSources = new Set(knownCandidates.flatMap((candidate) => candidate.sourceRowIds))
  if (candidateSources.size !== proposal.sourceRowIds.length
    || proposal.sourceRowIds.some((id) => !candidateSources.has(id))) return fail('source_provenance_mismatch')
  const expectedItems = knownCandidates
    .sort((left, right) => left.sourceOrder - right.sourceOrder || left.id.localeCompare(right.id))
    .map(normalizedCandidateItem)
  if (stableCanonicalJson(expectedItems) !== stableCanonicalJson(proposal.proposedItems)) {
    return fail('unknown_candidate_item')
  }
  const destinationSectionIndex = resolveCandidateSectionIndex(knownCandidates, context.sections)
  if (destinationSectionIndex === null || proposal.destinationSectionIndex !== destinationSectionIndex
    || proposal.candidateSourceOrder !== Math.min(...knownCandidates.map((candidate) => candidate.sourceOrder))) {
    return fail('source_provenance_mismatch')
  }
  const destinationItemIndex = expectedDestinationItemIndex(proposal, knownCandidates, context, destinationSectionIndex)
  if (destinationItemIndex === null || proposal.destinationItemIndex !== destinationItemIndex) return fail('source_provenance_mismatch')
  return null
}

function candidateQuotedTotal(proposal: ExtractionProposal, context: ProposalValidationContext): number | null {
  if (!context.candidateItems || !proposal.candidateItemIds) return null
  let sum = 0
  for (const id of proposal.candidateItemIds) {
    const candidate = context.candidateItems.get(id)
    if (!candidate || !finiteNonNegative(candidate.total)) return null
    sum += candidate.total
  }
  return Number.isFinite(sum) ? sum : null
}

function isNumericOnlyEvidence(row: ProposalValidationSourceRow): boolean {
  if (!Array.isArray(row.rawCells)) return false
  const texts = row.rawCells
    .filter((cell) => !cell.carried && cell.rawText.trim() !== '')
    .map((cell) => cell.rawText.trim())
  return texts.length > 0 && texts.every((text) => /^(?:(?:THB|USD|SGD|฿|\$)\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:THB|USD|SGD|฿|\$))?$/i.test(text))
}

function safeSpuriousSource(row: ProposalValidationSourceRow): boolean {
  return (typeof row.classification === 'string' && ['header', 'section', 'total', 'note'].includes(row.classification))
    || (Array.isArray(row.warnings) && row.warnings.some((warning) => warning.code === 'unsupported_row') && isNumericOnlyEvidence(row))
}

function validateOperation(proposal: ExtractionProposal, context: ProposalValidationContext): ProposalValidationResult {
  const proposed = proposal.proposedItems
  if ((proposal.operation === 'keep' || proposal.operation === 'needs_human_review') && proposed.length !== 0) {
    return fail('invalid_operation_shape')
  }
  if (proposal.operation === 'needs_human_review') return validProposal(proposal)
  if (proposal.operation === 'keep') {
    if (proposal.targetItemIds.length === 0 || proposal.sourceRowIds.length === 0) return fail('invalid_operation_shape')
    const expectedTotal = quotedTotal(proposal.sourceRowIds, context)
    if (expectedTotal === null) return fail('missing_source_evidence')
    return validProposal(proposal)
  }

  // Spurious removal does not require priced source evidence, but every source
  // row must be deterministically structural or numeric-only summary evidence.
  if (proposal.operation === 'remove_spurious_item') {
    if (proposed.length !== 0) return fail('invalid_operation_shape')
    const sourceById = new Map(context.sourceRows.map((row) => [row.id, row]))
    if (proposal.sourceRowIds.some((id) => !sourceById.has(id) || !safeSpuriousSource(sourceById.get(id)!))) {
      return fail('spurious_removal_blocked')
    }
    if (context.candidateItems) {
      const candidateSourceRows = new Set<string>()
      for (const candidate of context.candidateItems.values()) candidate.sourceRowIds.forEach((id) => candidateSourceRows.add(id))
      if (proposal.sourceRowIds.some((id) => candidateSourceRows.has(id))) return fail('spurious_removal_blocked')
    }
    return validProposal(proposal)
  }

  const expectedTotal = ['insert_missing_item', 'replace_item'].includes(proposal.operation)
    ? candidateQuotedTotal(proposal, context)
    : quotedTotal(proposal.sourceRowIds, context)
  if (expectedTotal === null) return fail('missing_source_evidence')

  if (proposal.operation === 'split') {
    if (proposal.targetItemIds.length !== 1 || proposed.length < 2 || !everyPriced(proposed)
      || proposed.some((item) => item.pricingRole !== 'standard')) return fail('reconciliation_mismatch')
    if (proposed.some((item) => item.costComponent === 'material' || item.costComponent === 'labour')) {
      return fail('invented_component_price')
    }
    if (!approximatelyEqual(totals(proposed), expectedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  if (proposal.operation === 'merge') {
    if (proposal.targetItemIds.length < 2 || proposed.length !== 1 || !everyPriced(proposed)
      || proposed[0].pricingRole !== 'standard') {
      return fail('invalid_operation_shape')
    }
    if (!approximatelyEqual(proposed[0].total, expectedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  if (proposal.operation === 'separate_components') {
    if (proposal.targetItemIds.length !== 1 || proposal.sourceRowIds.length !== 1 || proposed.length !== 2 || !everyPriced(proposed)) {
      return fail('invalid_operation_shape')
    }
    const evidence = context.sourceEvidence[proposal.sourceRowIds[0]]
    if (!evidence?.components) return fail('invented_component_price')
    const material = proposed.find((item) => item.costComponent === 'material')
    const labour = proposed.find((item) => item.costComponent === 'labour')
    if (!material || !labour || proposed.some((item) => item.pricingRole !== 'standard')
      || proposed.some((item) => item.costComponent !== 'material' && item.costComponent !== 'labour')) {
      return fail('invalid_operation_shape')
    }
    if (!hasValidComponent(evidence.components.material) || !hasValidComponent(evidence.components.labour)) return fail('missing_source_evidence')
    if (!sameComponent(material, evidence.components.material) || !sameComponent(labour, evidence.components.labour)) {
      return fail('invented_component_price')
    }
    if (!approximatelyEqual(material.total + labour.total, evidence.quotedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  if (proposal.operation === 'create_bundle') {
    const parents = proposed.filter((item): item is ProposalPricedItem => item.pricingRole === 'bundle_parent')
    const children = proposed.filter((item): item is ProposalBundleChild => item.pricingRole === 'bundle_child')
    if (parents.length !== 1 || children.length === 0 || proposed.length !== parents.length + children.length
      || children.some((child) => child.parentBundleId !== parents[0].id)
      || !approximatelyEqual(parents[0].total, expectedTotal)) return fail('invalid_bundle')
    return validProposal(proposal)
  }

  if (proposal.operation === 'insert_missing_item') {
    if (proposal.targetItemIds.length !== 0 || proposed.length === 0) return fail('invalid_operation_shape')
    if (!everyPriced(proposed) || proposed.some((item) => item.pricingRole !== 'standard')) return fail('invalid_operation_shape')
    if (!approximatelyEqual(totals(proposed), expectedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  if (proposal.operation === 'replace_item') {
    if (proposal.targetItemIds.length === 0 || proposed.length === 0) return fail('invalid_operation_shape')
    if (!everyPriced(proposed) || proposed.some((item) => item.pricingRole !== 'standard')) return fail('invalid_operation_shape')
    if (!approximatelyEqual(totals(proposed), expectedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  return fail('unknown_operation')
}

function optionalState(value: {
  optional?: boolean
  excludedFromTotal?: boolean
  exclusionReason?: string | null
}): {
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason: string | null
} {
  return {
    optional: value.optional === true,
    excludedFromTotal: value.excludedFromTotal === true,
    exclusionReason: value.exclusionReason ?? null,
  }
}

function sameOptionalState(
  left: ReturnType<typeof optionalState>,
  right: ReturnType<typeof optionalState>,
): boolean {
  return left.optional === right.optional
    && left.excludedFromTotal === right.excludedFromTotal
    && left.exclusionReason === right.exclusionReason
}

function validateTargetOptionalState(
  proposal: ExtractionProposal,
  context: ProposalValidationContext,
): ProposalValidationResult | null {
  if (proposal.proposedItems.length === 0) return null
  if (proposal.targetItemIds.length === 0) return null // targetless insert
  const known = knownItems(context.sections)
  const targets = proposal.targetItemIds.map((id) => known.get(id)).filter((item): item is BoqItem => item !== undefined)
  if (targets.length !== proposal.targetItemIds.length) return fail('unknown_target_item')
  const states = targets.map(optionalState)
  const expected = states[0]
  if (!expected || states.some((state) => !sameOptionalState(state, expected))) return fail('target_state_mismatch')
  const priced = proposal.proposedItems.filter((item) => item.pricingRole !== 'bundle_child')
  if (priced.some((item) => !sameOptionalState(optionalState(item), expected))) return fail('target_state_mismatch')
  return null
}

function sameComponent(item: ProposalPricedItem, evidence: ProposalSourceComponentEvidence): boolean {
  return item.unit === evidence.unit
    && approximatelyEqual(item.qty, evidence.qty)
    && approximatelyEqual(item.rate, evidence.rate)
    && approximatelyEqual(item.total, evidence.total)
}

function validProposal(proposal: ExtractionProposal): ProposalValidationResult {
  return {
    valid: true,
    proposal: { ...structuredClone(proposal), evidenceValid: true, reconciled: true, stale: false },
  }
}

/**
 * Validates untrusted structured model output. Validation never changes canonical
 * BOQ sections; only a separately authorized acceptance path may call apply.
 */
export function validateProposal(value: unknown, context: ProposalValidationContext): ProposalValidationResult {
  if (!isRecord(value)
    || !nonBlankString(value.id)
    || !nonBlankString(value.operation)
    || !Array.isArray(value.sourceRowIds)
    || !value.sourceRowIds.every(nonBlankString)
    || !Array.isArray(value.targetItemIds)
    || !value.targetItemIds.every(nonBlankString)
    || !isRecord(value.affectedItemFingerprints)
    || !nonBlankString(value.explanation)
    || !Array.isArray(value.proposedItems)
  ) return fail('invalid_shape')

  if (!PROPOSAL_OPERATIONS.includes(value.operation as ProposalOperation)) return fail('unknown_operation')
  if (!finiteNonNegative(value.confidence) || value.confidence > 1) return fail('invalid_confidence')
  if (!nonBlankString(value.extractionRunId)) return fail('run_identity_mismatch')

  const proposal = value as unknown as ExtractionProposal
  if (proposal.extractionRunId !== context.extractionRunId) return fail('run_identity_mismatch')
  if (proposal.sourceRowIds.length === 0) return fail('invalid_operation_shape')
  if (new Set(proposal.sourceRowIds).size !== proposal.sourceRowIds.length) return fail('duplicate_source_row')
  if (new Set(proposal.targetItemIds).size !== proposal.targetItemIds.length) return fail('invalid_operation_shape')
  const knownSourceRows = new Set(context.sourceRows.map((row) => row.id))
  if (proposal.sourceRowIds.some((sourceRowId) => !knownSourceRows.has(sourceRowId))) return fail('unknown_source_row')
  const metadataFailure = validateSourceBackedMetadata(proposal)
  if (metadataFailure) return metadataFailure
  const known = knownItems(context.sections)
  const requiresTargets = OPERATIONS_REQUIRING_TARGETS.has(proposal.operation)
  const hasTargets = proposal.targetItemIds.length > 0
  if (requiresTargets && !hasTargets) return fail('invalid_operation_shape')
  if (proposal.operation === 'insert_missing_item' && hasTargets) return fail('invalid_operation_shape')
  if (!requiresTargets && proposal.operation !== 'needs_human_review' && proposal.operation !== 'insert_missing_item' && !hasTargets) {
    return fail('invalid_operation_shape')
  }

  if (hasTargets) {
    if (proposal.targetItemIds.some((itemId) => !known.has(itemId))) return fail('unknown_target_item')
    if (Object.keys(proposal.affectedItemFingerprints).length !== proposal.targetItemIds.length
      || proposal.targetItemIds.some((itemId) => typeof proposal.affectedItemFingerprints[itemId] !== 'string'
        || proposal.affectedItemFingerprints[itemId] !== fingerprintCanonicalItem(known.get(itemId)!))) {
      return fail('stale_item')
    }
    const canonicalSourceByTarget = new Map<string, Set<string>>()
    const allTargetSources = new Set<string>()
    for (const targetId of proposal.targetItemIds) {
      const sources = new Set(canonicalTargetSourceRows(known.get(targetId)!))
      canonicalSourceByTarget.set(targetId, sources)
      sources.forEach((sourceRowId) => allTargetSources.add(sourceRowId))
    }
    if (proposal.sourceRowIds.some((sourceRowId) => !allTargetSources.has(sourceRowId))) return fail('target_source_mismatch')
    if (proposal.targetItemIds.some((targetId) => {
      const sources = canonicalSourceByTarget.get(targetId)!
      return !proposal.sourceRowIds.some((sourceRowId) => sources.has(sourceRowId))
    })) return fail('target_source_mismatch')
  } else if (proposal.operation === 'insert_missing_item') {
    const canonicalBySource = new Set<string>()
    for (const section of context.sections) {
      for (const item of section.items) canonicalTargetSourceRows(item).forEach((id) => canonicalBySource.add(id))
    }
    if (proposal.sourceRowIds.some((id) => canonicalBySource.has(id))) return fail('duplicate_canonical_source')
  } else if (Object.keys(proposal.affectedItemFingerprints).length !== 0) {
    return fail('stale_item')
  }

  if (REVIEW_ACTIONABLE_OPERATIONS.has(proposal.operation)) {
    if (!nonBlankString(proposal.baseSectionsFingerprint)
      || proposal.baseSectionsFingerprint !== fingerprintCanonicalSections(context.sections)) return fail('stale_item')
    if (proposal.operation === 'remove_spurious_item') {
      if (!Array.isArray(proposal.candidateItemIds) || proposal.candidateItemIds.length !== 0) return fail('invalid_operation_shape')
    } else {
      const candidateFailure = validateCandidateExpansion(proposal, context)
      if (candidateFailure) return candidateFailure
    }
  }

  if (!proposal.proposedItems.every((item) => validProposedItem(item, proposal.sourceRowIds))) {
    const arithmetic = proposal.proposedItems.some((item) => isRecord(item)
      && item.pricingRole !== 'bundle_child'
      && finiteNonNegative(item.qty) && finiteNonNegative(item.rate) && finiteNonNegative(item.total)
      && !approximatelyEqual(item.qty * item.rate, item.total))
    return fail(arithmetic ? 'arithmetic_mismatch' : 'invalid_shape')
  }
  if (proposal.proposedItems.length > 0) {
    const proposedSourceRows = new Set(proposal.proposedItems.flatMap((item) => item.sourceRowIds))
    if (proposedSourceRows.size !== proposal.sourceRowIds.length
      || proposal.sourceRowIds.some((sourceRowId) => !proposedSourceRows.has(sourceRowId))) {
      return fail('source_provenance_mismatch')
    }
  }
  const proposedIds = proposal.proposedItems.map((item) => item.id)
  if (new Set(proposedIds).size !== proposedIds.length) return fail('duplicate_item_id')
  if (proposedIds.some((itemId) => known.has(itemId) && !proposal.targetItemIds.includes(itemId))) return fail('duplicate_item_id')
  const targetStateFailure = validateTargetOptionalState(proposal, context)
  if (targetStateFailure) return targetStateFailure
  return validateOperation(proposal, context)
}

export function validateProposalBatch(values: unknown[], context: ProposalValidationContext): ProposalBatchValidationResult {
  const seenProposalIds = new Set<string>()
  const seenTargets = new Set<string>()
  const seenRows = new Set<string>()
  const results = values.map((value) => {
    const result = validateProposal(value, context)
    if (!result.valid) return result
    if (seenProposalIds.has(result.proposal.id)) return fail('duplicate_proposal')
    if (result.proposal.targetItemIds.some((id) => seenTargets.has(id))) return fail('overlapping_target')
    if (result.proposal.sourceRowIds.some((id) => seenRows.has(id))) return fail('overlapping_source_row')
    seenProposalIds.add(result.proposal.id)
    result.proposal.targetItemIds.forEach((id) => seenTargets.add(id))
    result.proposal.sourceRowIds.forEach((id) => seenRows.add(id))
    return result
  })
  return { valid: results.every((result) => result.valid), results }
}

export function isHighConfidenceProposal(proposal: ValidatedProposal): boolean {
  return proposal.confidence >= 0.90
    && proposal.evidenceValid
    && proposal.reconciled
    && isReviewActionableOperation(proposal.operation)
    && proposal.stale !== true
}

function toCanonicalItem(item: ProposedExtractionItem, operation: ProposalOperation): BoqItem {
  const common = {
    id: item.id,
    desc: item.desc,
    sourceRowId: item.sourceRowIds[0],
    sourceRowIds: [...item.sourceRowIds],
    ...(item.sourceRef ? { sourceRef: { ...item.sourceRef } } : {}),
    entryOrigin: 'ai_accepted' as const,
    ...(item.optional === true ? { optional: true } : {}),
    ...(item.excludedFromTotal === true ? { excludedFromTotal: true } : {}),
    ...(nonBlankString(item.exclusionReason) ? { exclusionReason: item.exclusionReason } : {}),
  }
  if (item.pricingRole === 'bundle_child') {
    return { ...common, pricingRole: 'bundle_child', parentBundleId: item.parentBundleId, stdStatus: 'pending' }
  }
  const priced: BoqPricedItem = {
    ...common,
    pricingRole: item.pricingRole,
    unit: item.unit,
    qty: item.qty,
    rate: item.rate,
    total: item.total,
    type: item.costComponent === 'lump_sum' ? 'lump_sum' : 'unit',
    costComponent: item.costComponent,
    ...(operation === 'separate_components' && item.costComponent === 'material' ? {
      costAllocation: { basis: 'rate' as const, material: item.rate, labour: 0, origin: 'source' as const },
    } : {}),
    ...(operation === 'separate_components' && item.costComponent === 'labour' ? {
      costAllocation: { basis: 'rate' as const, material: 0, labour: item.rate, origin: 'source' as const },
    } : {}),
    ...((operation === 'insert_missing_item' || operation === 'replace_item') && item.sourceCosts ? {
      // Normalize native sourceCosts first; allocation is derived below so
      // same-unit rows keep rate basis and different-unit rows use totals.
      sourceCosts: {
        material: { ...item.sourceCosts.material, present: true },
        labour: { ...item.sourceCosts.labour, present: true },
      },
    } : {}),
    stdStatus: item.excludedFromTotal === true ? 'excluded' : 'unmatched',
  }
  if ((operation === 'insert_missing_item' || operation === 'replace_item') && priced.sourceCosts) {
    const allocation = deriveSourceCostAllocation(priced)
    if (allocation) return { ...priced, costAllocation: allocation }
  }
  return priced
}

/** Applies only a previously validated proposal after explicit user acceptance. */
export function applyValidatedProposal(
  sections: readonly BoqSection[],
  proposal: ValidatedProposal,
  options: { skipBaseRevisionCheck?: boolean } = {},
): { sections: BoqSection[]; audit: ProposalAcceptanceAudit } {
  if (proposal.operation === 'needs_human_review') throw new TypeError('A human review proposal cannot be applied')
  const beforeSections = structuredClone(sections) as BoqSection[]
  if (!options.skipBaseRevisionCheck && proposal.baseSectionsFingerprint
    && fingerprintCanonicalSections(beforeSections) !== proposal.baseSectionsFingerprint) throw new ProposalUndoConflictError()
  const current = knownItems(beforeSections)

  if (proposal.operation === 'insert_missing_item') {
    const destSectionIndex = proposal.destinationSectionIndex
    const destinationItemIndex = proposal.destinationItemIndex
    if (!Number.isInteger(destSectionIndex) || destSectionIndex! < 0 || destSectionIndex! >= beforeSections.length
      || !Number.isInteger(destinationItemIndex) || destinationItemIndex! < 0
      || destinationItemIndex! > beforeSections[destSectionIndex!].items.length) {
      throw new TypeError('Insert proposal has no valid server-owned destination')
    }
    const nextItems = [...beforeSections[destSectionIndex!].items]
    nextItems.splice(destinationItemIndex!, 0, ...proposal.proposedItems.map((item) => toCanonicalItem(item, proposal.operation)))
    const nextSections = beforeSections.map((section, index) =>
      index === destSectionIndex ? { ...section, items: nextItems } : section)
    const audit: ProposalAcceptanceAudit = {
      proposalId: proposal.id,
      operation: proposal.operation,
      beforeSections,
      beforeSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
      afterSectionsFingerprint: fingerprintCanonicalSections(nextSections),
    }
    return { sections: nextSections, audit }
  }

  if (proposal.targetItemIds.some((id) => {
    const currentItem = current.get(id)
    return !currentItem || fingerprintCanonicalItem(currentItem) !== proposal.affectedItemFingerprints[id]
  })) {
    throw new ProposalUndoConflictError()
  }
  const affectedSections = beforeSections
    .map((section, sectionIndex) => ({ sectionIndex, hasTarget: section.items.some((item) => proposal.targetItemIds.includes(item.id ?? '')) }))
    .filter((entry) => entry.hasTarget)
  if (affectedSections.length !== 1) throw new TypeError('A proposal must replace targets from exactly one section')
  const sectionIndex = affectedSections[0].sectionIndex
  const targetIds = new Set(proposal.targetItemIds)
  const targetIndexes = beforeSections[sectionIndex].items
    .map((item, index) => targetIds.has(item.id ?? '') ? index : -1)
    .filter((index) => index >= 0)
  const insertAt = Math.min(...targetIndexes)
  const nextItems = proposal.operation === 'keep'
    ? [...beforeSections[sectionIndex].items]
    : beforeSections[sectionIndex].items.filter((item) => !targetIds.has(item.id ?? ''))
  if (proposal.operation !== 'keep' && proposal.operation !== 'remove_spurious_item') {
    nextItems.splice(insertAt, 0, ...proposal.proposedItems.map((item) => toCanonicalItem(item, proposal.operation)))
  }
  const nextSections = beforeSections.map((section, index) => index === sectionIndex ? { ...section, items: nextItems } : section)
  const audit: ProposalAcceptanceAudit = {
    proposalId: proposal.id,
    operation: proposal.operation,
    beforeSections,
    beforeSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
    afterSectionsFingerprint: fingerprintCanonicalSections(nextSections),
  }
  return { sections: nextSections, audit }
}

export function undoAcceptedProposal(sections: readonly BoqSection[], audit: ProposalAcceptanceAudit): BoqSection[] {
  if (fingerprintCanonicalSections(sections) !== audit.afterSectionsFingerprint) throw new ProposalUndoConflictError()
  return structuredClone(audit.beforeSections)
}
