import type { ExtractionReviewResponse } from "./boq-extraction-ai-review"
import { isReviewActionableOperation, normalizeValidationSummary, type ProposalOperation, type ValidatedProposal } from "./boq-extraction-proposals"

export type ExtractionProposalStatus = "accepted" | "rejected" | "skipped" | "superseded" | "undone"
export type ExtractionProposalStatusMap = Record<string, ExtractionProposalStatus | undefined>
export type ReviewTab = "needs-review" | "history"
export type ExtractionReviewFilter = "all" | "pending" | "accepted" | "rejected" | "needs-attention" | "ambiguous" | "unreconciled" | "ai-pending"
export type ExtractionReviewSourceFilter = Extract<ExtractionReviewFilter, "ambiguous" | "unreconciled" | "ai-pending">
export type ExtractionProposalAction = "accepting" | "rejecting" | "skipping" | "reopening" | "undoing" | "adding"

export interface ReviewSnapshotGeneration {
  current: number
}

export function beginReviewSnapshotRequest(generation: ReviewSnapshotGeneration): number {
  generation.current += 1
  return generation.current
}

export function isLatestReviewSnapshotRequest(generation: ReviewSnapshotGeneration, requestGeneration: number): boolean {
  return generation.current === requestGeneration
}

export function invalidateReviewSnapshotRequests(generation: ReviewSnapshotGeneration): void {
  generation.current += 1
}

export interface ExtractionReviewState {
  review: ExtractionReviewResponse | null
  proposalStatuses: ExtractionProposalStatusMap
  proposalCanUndo: Record<string, boolean | undefined>
  proposalActions: Record<string, ExtractionProposalAction | undefined>
  expandedProposalIds: Record<string, boolean | undefined>
  filter: ExtractionReviewFilter
  tab: ReviewTab
  loading: boolean
  requestedSourceRowId?: string
  error: string | null
}

export type ExtractionReviewAction =
  | { type: "review_started"; sourceRowId?: string }
  | { type: "review_succeeded"; response: ExtractionReviewResponse; sourceRowId?: string }
  | { type: "review_failed"; error: string }
  | { type: "proposal_action_started"; proposalId: string; action: ExtractionProposalAction }
  | { type: "proposal_status"; proposalId: string; status: ExtractionProposalStatus; canUndo?: boolean }
  | { type: "proposal_statuses"; statuses: Record<string, { status: "pending" | ExtractionProposalStatus; canUndo: boolean }> }
  | { type: "proposal_action_failed"; proposalId: string; error: string }
  | { type: "toggle_expanded"; proposalId: string }
  | { type: "set_filter"; filter: ExtractionReviewFilter }
  | { type: "set_tab"; tab: ReviewTab }

export function initialExtractionReviewState(): ExtractionReviewState {
  return {
    review: null,
    proposalStatuses: {},
    proposalCanUndo: {},
    proposalActions: {},
    expandedProposalIds: {},
    filter: "all",
    tab: "needs-review",
    loading: false,
    error: null,
  }
}

function mergeRowReview(current: ExtractionReviewResponse, incoming: ExtractionReviewResponse, sourceRowId: string): ExtractionReviewResponse {
  const unrelatedProposals = current.proposals.filter((proposal) => !proposal.sourceRowIds.includes(sourceRowId))
  const unrelatedRows = current.sourceRows.filter((row) => row.sourceRowId !== sourceRowId)
  const unrelatedRefs = current.sourceRefs.filter((reference) => reference.sourceRowId !== sourceRowId)
  const sourceRowIds = [...new Set([...unrelatedRows.map((row) => row.sourceRowId), ...incoming.sourceRowIds])]
  return {
    ...incoming,
    sourceRowIds,
    sourceRows: [...unrelatedRows, ...incoming.sourceRows],
    sourceRefs: [...unrelatedRefs, ...incoming.sourceRefs],
    proposals: [...unrelatedProposals, ...incoming.proposals],
    rejectedProposals: [...current.rejectedProposals, ...incoming.rejectedProposals],
    remainingCandidateRowIds: [...new Set([...current.remainingCandidateRowIds.filter((id) => id !== sourceRowId), ...incoming.remainingCandidateRowIds])],
  }
}

function isReplacementSnapshot(response: ExtractionReviewResponse): boolean {
  return (response as ExtractionReviewResponse & { snapshotMode?: string }).snapshotMode === "replace"
}

export function extractionReviewReducer(state: ExtractionReviewState, action: ExtractionReviewAction): ExtractionReviewState {
  switch (action.type) {
    case "review_started":
      return { ...state, loading: true, requestedSourceRowId: action.sourceRowId, error: null }
    case "review_succeeded":
      const replacementStatuses = isReplacementSnapshot(action.response) ? action.response.proposalStatuses ?? {} : null
      return {
        ...state,
        review: action.sourceRowId && state.review && !isReplacementSnapshot(action.response) ? mergeRowReview(state.review, action.response, action.sourceRowId) : action.response,
        ...(replacementStatuses ? {
          proposalStatuses: Object.fromEntries(Object.entries(replacementStatuses)
            .map(([id, summary]) => [id, summary.status === "pending" ? undefined : summary.status])),
          proposalCanUndo: Object.fromEntries(Object.entries(replacementStatuses).map(([id, summary]) => [id, summary.canUndo])),
          proposalActions: {},
        } : {}),
        loading: false,
        requestedSourceRowId: undefined,
        error: null,
      }
    case "review_failed":
      return { ...state, loading: false, requestedSourceRowId: undefined, error: action.error }
    case "proposal_action_started":
      return { ...state, error: null, proposalActions: { ...state.proposalActions, [action.proposalId]: action.action } }
    case "proposal_status":
      return {
        ...state,
        proposalStatuses: { ...state.proposalStatuses, [action.proposalId]: action.status },
        proposalCanUndo: { ...state.proposalCanUndo, [action.proposalId]: action.canUndo ?? false },
        proposalActions: { ...state.proposalActions, [action.proposalId]: undefined },
      }
    case "proposal_statuses":
      return {
        ...state,
        proposalStatuses: {
          ...state.proposalStatuses,
          ...Object.fromEntries(Object.entries(action.statuses).map(([id, summary]) => [id, summary.status === "pending" ? undefined : summary.status])),
        },
        proposalCanUndo: { ...state.proposalCanUndo, ...Object.fromEntries(Object.entries(action.statuses).map(([id, summary]) => [id, summary.canUndo])) },
      }
    case "proposal_action_failed":
      return { ...state, error: action.error, proposalActions: { ...state.proposalActions, [action.proposalId]: undefined } }
    case "toggle_expanded":
      return { ...state, expandedProposalIds: { ...state.expandedProposalIds, [action.proposalId]: state.expandedProposalIds[action.proposalId] === false } }
    case "set_filter":
      return { ...state, filter: action.filter }
    case "set_tab":
      return { ...state, tab: action.tab }
  }
}

export function filterReviewProposals(
  proposals: readonly ValidatedProposal[],
  statuses: ExtractionProposalStatusMap,
  filter: ExtractionReviewFilter,
): ValidatedProposal[] {
  if (filter === "all" || filter === "ambiguous" || filter === "unreconciled" || filter === "ai-pending") return [...proposals]
  return proposals.filter((proposal) => {
    const status = statuses[proposal.id]
    if (filter === "pending") return !status && isReviewActionableOperation(proposal.operation)
    if (filter === "accepted") return status === "accepted"
    if (filter === "rejected") return status === "rejected"
    return !isReviewActionableOperation(proposal.operation) || proposal.stale || !proposal.evidenceValid || !proposal.reconciled
  })
}

export function selectReviewTab(
  state: Pick<ExtractionReviewState, "review" | "proposalStatuses"> | { review: ExtractionReviewResponse; proposalStatuses: ExtractionProposalStatusMap },
  tab: ReviewTab,
): { tab: ReviewTab; proposals: ValidatedProposal[]; proposalIds: string[] } {
  const proposals = state.review?.proposals ?? []
  const selected = proposals.filter((proposal) => {
    const status = state.proposalStatuses[proposal.id]
    return tab === "history"
      ? status === "accepted" || status === "rejected" || status === "skipped" || status === "undone" || status === "superseded"
      : status === undefined
  })
  return { tab, proposals: selected, proposalIds: selected.map((proposal) => proposal.id) }
}


type ReviewWithRunState = ExtractionReviewResponse & {
  reviewRun?: {
    status: string
    reviewTargeting: {
      candidateRowIds: string[]
      ambiguousRowIds?: string[]
      unreconciledRowIds?: string[]
      unreconciled: boolean
    }
  }
}

export function filterReviewSourceRows(review: ReviewWithRunState, filter: ExtractionReviewSourceFilter) {
  const targeting = review.reviewRun?.reviewTargeting
  const candidateIds = new Set(targeting?.candidateRowIds ?? review.sourceRows
    .filter((row) => row.confidence < 0.9 || row.warnings.length > 0 || ["continuation", "option", "unknown"].includes(row.classification))
    .map((row) => row.sourceRowId))
  const ambiguousIds = new Set(targeting?.ambiguousRowIds ?? review.sourceRows
    .filter((row) => row.confidence < 0.9 || row.classification === "unknown"
      || row.warnings.some((warning) => /ambiguous|unsupported|incomplete|invalid_numeric|numeric_overflow/.test(warning.code)))
    .map((row) => row.sourceRowId))
  const unreconciledIds = new Set(targeting?.unreconciledRowIds ?? [])
  if (filter === "ambiguous") return review.sourceRows.filter((row) => ambiguousIds.has(row.sourceRowId))
  if (filter === "unreconciled") return review.sourceRows.filter((row) => unreconciledIds.has(row.sourceRowId))
  const pendingIds = new Set(review.remainingCandidateRowIds)
  if (["queued", "running"].includes(review.reviewRun?.status ?? "")) candidateIds.forEach((id) => pendingIds.add(id))
  return review.sourceRows.filter((row) => pendingIds.has(row.sourceRowId))
}

export function selectReviewVisibility(
  review: ExtractionReviewResponse,
  statuses: ExtractionProposalStatusMap,
  filter: ExtractionReviewFilter,
): { proposals: ValidatedProposal[]; sourceRows: ExtractionReviewResponse["sourceRows"] } {
  if (filter === "all") {
    const proposedRowIds = new Set(review.proposals.flatMap((proposal) => proposal.sourceRowIds))
    return {
      proposals: [...review.proposals],
      sourceRows: review.sourceRows.filter((row) => !proposedRowIds.has(row.sourceRowId)),
    }
  }
  if (filter !== "ambiguous" && filter !== "unreconciled" && filter !== "ai-pending") {
    return { proposals: filterReviewProposals(review.proposals, statuses, filter), sourceRows: [] }
  }
  const matchingRows = filterReviewSourceRows(review, filter)
  const matchingRowIds = new Set(matchingRows.map((row) => row.sourceRowId))
  const proposals = review.proposals.filter((proposal) => proposal.sourceRowIds.some((rowId) => matchingRowIds.has(rowId)))
  const proposedRowIds = new Set(proposals.flatMap((proposal) => proposal.sourceRowIds))
  return { proposals, sourceRows: matchingRows.filter((row) => !proposedRowIds.has(row.sourceRowId)) }
}

/** Returns the filter that should actually be rendered/pressed. When the selected
 *  filter has zero results it falls back to "all" so a disabled chip is never
 *  shown as selected, even before the reducer dispatch resets it. */
export function selectEffectiveFilter(
  review: ExtractionReviewResponse,
  statuses: ExtractionProposalStatusMap,
  selectedFilter: ExtractionReviewFilter,
): ExtractionReviewFilter {
  if (selectedFilter === "all") return "all"
  const visibility = selectReviewVisibility(review, statuses, selectedFilter)
  return visibility.proposals.length === 0 && visibility.sourceRows.length === 0 ? "all" : selectedFilter
}

export type ExtractionReviewRefreshAction = "dispatch" | "poll" | "idle"

export function extractionReviewRefreshAction(
  review: ExtractionReviewResponse,
  readOnly: boolean,
  now = Date.now(),
): ExtractionReviewRefreshAction {
  const status = (review as ReviewWithRunState).reviewRun?.status
  if (!status) return !readOnly && review.proposals.length === 0 ? "dispatch" : "idle"
  if (status === "queued") return readOnly ? "idle" : "dispatch"
  if (status !== "running") return "idle"
  const leaseExpiresAt = review.reviewRun?.leaseExpiresAt
  const expiry = typeof leaseExpiresAt === "string" ? Date.parse(leaseExpiresAt) : Number.NaN
  if (Number.isFinite(expiry) && expiry > now) return "poll"
  return readOnly ? "idle" : "dispatch"
}

type BulkProposal = {
  id: string
  operation: ProposalOperation | string
  confidence: number
  evidenceValid: boolean
  reconciled: boolean
  stale: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isSourceRow(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.sourceRowId === "string"
    && Number.isFinite(value.page)
    && Number.isFinite(value.table)
    && Number.isFinite(value.row)
    && (value.section === null || typeof value.section === "string")
    && isStringArray(value.headers)
    && typeof value.rawText === "string"
    && Array.isArray(value.rawCells)
    && typeof value.classification === "string"
    && Number.isFinite(value.confidence)
    && Array.isArray(value.warnings)
}

function validProposalStatuses(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return Object.values(value).every((summary) => isRecord(summary)
    && ["pending", "accepted", "rejected", "skipped", "undone", "superseded"].includes(String(summary.status))
    && typeof summary.canUndo === "boolean"
    && (summary.stale === undefined || typeof summary.stale === "boolean")
    && (summary.eligible === undefined || typeof summary.eligible === "boolean"))
}

function validReviewRun(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || !["queued", "running", "completed", "partial", "failed"].includes(String(value.status))) return false
  if (value.reviewedSourceRowIds !== undefined && !isStringArray(value.reviewedSourceRowIds)) return false
  if (value.validationSummary !== undefined && normalizeValidationSummary(value.validationSummary) === null) return false
  if (!isRecord(value.reviewTargeting) || !isStringArray(value.reviewTargeting.candidateRowIds)
    || (value.reviewTargeting.ambiguousRowIds !== undefined && !isStringArray(value.reviewTargeting.ambiguousRowIds))
    || (value.reviewTargeting.unreconciledRowIds !== undefined && !isStringArray(value.reviewTargeting.unreconciledRowIds))
    || typeof value.reviewTargeting.unreconciled !== "boolean") return false
  return ["requestKey", "leaseId", "leaseExpiresAt", "failureCode", "retryAfter", "updatedAt"]
    .every((key) => value[key] === undefined || typeof value[key] === "string")
}

const REVIEW_DRAFT_RESOLVED_KEYS = new Set([
  "description", "unit", "quantity", "rate", "total",
  "materialRate", "materialTotal", "labourRate", "labourTotal", "amount",
])
const REVIEW_MISSING_FIELDS = new Set([
  ...REVIEW_DRAFT_RESOLVED_KEYS, "destinationSection", "targetItemState",
])
const SOURCE_REF_KEYS = new Set(["sourceRowId", "column", "line"])
const SOURCE_LOCATION_KEYS = new Set(["page", "table", "row"])

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function uniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonBlankString) && new Set(value).size === value.length
}

function validSourceCellRefShape(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, SOURCE_REF_KEYS)) return false
  if (!nonBlankString(value.sourceRowId) || !isInteger(value.column) || (value.column as number) < 0) return false
  return value.line === undefined || (isInteger(value.line) && (value.line as number) >= 0)
}

/** Loose shape check for a `SourceCellMapping`. This is a secondary defense —
 *  the server's `validSourceCellMapping` performs the full prove-nance check
 *  against the proposal's sourceRowIds; here we only reject obviously
 *  malformed payloads so they cannot reach review UI state. */
function validSourceCellMappingShape(value: unknown, proposalSourceRowIds: readonly string[]): boolean {
  if (!isRecord(value) || !Array.isArray(value.sourceRowIds) || !uniqueStringArray(value.sourceRowIds)) return false
  if (value.sourceRowIds.length !== proposalSourceRowIds.length) return false
  const known = new Set(proposalSourceRowIds)
  if (!value.sourceRowIds.every((id: string) => known.has(id))) return false
  if (value.description !== undefined) {
    if (!Array.isArray(value.description) || value.description.length === 0
      || !value.description.every(validSourceCellRefShape)) return false
  }
  for (const key of ["unit", "quantity", "rate", "total", "materialRate", "materialTotal", "labourRate", "labourTotal", "amount"] as const) {
    if (value[key] !== undefined && !validSourceCellRefShape(value[key])) return false
  }
  return true
}

function validMappedCandidateShape(value: unknown, proposalSourceRowIds: readonly string[]): boolean {
  if (!isRecord(value)) return false
  if (!nonBlankString(value.id) || !isInteger(value.sectionIndex) || (value.sectionIndex as number) < 0) return false
  if (!nonBlankString(value.sectionHeader) || !isInteger(value.sourceOrder) || (value.sourceOrder as number) < 0) return false
  if (!uniqueStringArray(value.sourceRowIds) || value.sourceRowIds.length !== proposalSourceRowIds.length) return false
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length !== proposalSourceRowIds.length) return false
  if (!value.sourceRefs.every((ref: unknown) => isRecord(ref) && exactKeys(ref, SOURCE_LOCATION_KEYS)
    && isInteger(ref.page) && (ref.page as number) >= 0
    && isInteger(ref.table) && (ref.table as number) >= 0
    && isInteger(ref.row) && (ref.row as number) >= 0)) return false
  if (!nonBlankString(value.unit) || !isFiniteNonNegativeNumber(value.qty)
    || !isFiniteNonNegativeNumber(value.rate) || !isFiniteNonNegativeNumber(value.total)) return false
  return typeof value.optional === "boolean" && typeof value.excludedFromTotal === "boolean"
}

/** Shape-checks a `SourceBackedReviewDraft`. The server's `validReviewDraft`
 *  performs the canonical source-row ID match; this predicate only rejects
 *  payloads whose draft has clearly malformed refs/fields so they cannot
 *  reach the client editor. */
function validReviewDraftShape(value: unknown, proposalSourceRowIds: readonly string[]): boolean {
  if (!isRecord(value)) return false
  if (!validSourceCellMappingShape(value.mapping, proposalSourceRowIds)) return false
  if (!isRecord(value.resolvedValues)) return false
  for (const [key, entry] of Object.entries(value.resolvedValues)) {
    if (!REVIEW_DRAFT_RESOLVED_KEYS.has(key)) return false
    if (key === "description" || key === "unit") {
      if (entry !== undefined && !nonBlankString(entry)) return false
    } else if (entry !== undefined && !isFiniteNonNegativeNumber(entry)) return false
  }
  if (!Array.isArray(value.missingFields) || value.missingFields.length === 0) return false
  if (!value.missingFields.every((field) => typeof field === "string" && REVIEW_MISSING_FIELDS.has(field))) return false
  if (new Set(value.missingFields).size !== value.missingFields.length) return false
  if (!uniqueStringArray(value.sourceRowIds) || value.sourceRowIds.length !== proposalSourceRowIds.length) return false
  const known = new Set(proposalSourceRowIds)
  if (!value.sourceRowIds.every((id: string) => known.has(id))) return false
  if (!Array.isArray(value.sourceRefs)) return false
  if (!value.sourceRefs.every((ref: unknown) => isRecord(ref) && exactKeys(ref, SOURCE_LOCATION_KEYS)
    && isInteger(ref.page) && (ref.page as number) >= 0
    && isInteger(ref.table) && (ref.table as number) >= 0
    && isInteger(ref.row) && (ref.row as number) >= 0)) return false
  if (value.section !== null) {
    if (!isRecord(value.section)) return false
    if (!isInteger(value.section.index) || (value.section.index as number) < 0) return false
    if (!nonBlankString(value.section.header)) return false
  }
  return true
}

/** Per-proposal shape check. Mirrors the server decoder's metadata rules:
 *  reviewDraft requires needs_human_review + no mapping; mapping requires
 *  a paired mappedCandidate. Kept loose — the server runs the full
 *  structural validation pipeline before persisting. */
function validProposalShape(value: unknown): boolean {
  if (!isRecord(value) || !nonBlankString(value.id) || typeof value.operation !== "string") return false
  if (!Array.isArray(value.sourceRowIds) || !uniqueStringArray(value.sourceRowIds) || value.sourceRowIds.length === 0) return false
  const hasMapping = value.sourceCellMapping !== undefined
  const hasCandidate = value.mappedCandidate !== undefined
  const hasDraft = value.reviewDraft !== undefined
  if (hasMapping !== hasCandidate) return false
  if (hasDraft) {
    if (value.operation !== "needs_human_review" || hasMapping) return false
    if (!validReviewDraftShape(value.reviewDraft, value.sourceRowIds)) return false
  }
  if (hasMapping) {
    if (!["insert_missing_item", "replace_item"].includes(value.operation)) return false
    if (!validSourceCellMappingShape(value.sourceCellMapping, value.sourceRowIds)) return false
    if (!validMappedCandidateShape(value.mappedCandidate, value.sourceRowIds)) return false
  }
  return true
}

/** Rejects malformed client payloads instead of allowing a partial provider response into review state. */
export function normalizeExtractionReviewResponse(value: unknown): ExtractionReviewResponse | null {
  if (!isRecord(value) || !["ai", "fallback", "not_required"].includes(String(value.mode))) return null
  if (value.snapshotMode !== undefined && value.snapshotMode !== "replace") return null
  if (typeof value.aiStatus !== "string" || typeof value.message !== "string") return null
  if (!isStringArray(value.sourceRowIds) || !isStringArray(value.remainingCandidateRowIds)) return null
  if (!Array.isArray(value.sourceRefs) || !Array.isArray(value.sourceRows) || !value.sourceRows.every(isSourceRow)) return null
  if (!Array.isArray(value.proposals) || !value.proposals.every(validProposalShape) || !Array.isArray(value.rejectedProposals)) return null
  if (!validProposalStatuses(value.proposalStatuses) || !validReviewRun(value.reviewRun)
    || (value.auditEvents !== undefined && !Array.isArray(value.auditEvents))) return null
  return value as unknown as ExtractionReviewResponse
}

export function acceptAllValidatedProposalIds(
  proposals: readonly BulkProposal[],
  statuses: ExtractionProposalStatusMap,
): string[] {
  return proposals.filter((proposal) => (
    isReviewActionableOperation(proposal.operation)
    && proposal.confidence >= 0.9
    && proposal.evidenceValid === true
    && proposal.reconciled === true
    && proposal.stale !== true
    && !statuses[proposal.id]
  )).map((proposal) => proposal.id)
}
