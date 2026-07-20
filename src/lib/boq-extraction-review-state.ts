import type { ExtractionReviewResponse } from "./boq-extraction-ai-review"
import type { ProposalOperation, ValidatedProposal } from "./boq-extraction-proposals"

export type ExtractionProposalStatus = "accepted" | "rejected" | "undone"
export type ExtractionProposalStatusMap = Record<string, ExtractionProposalStatus | undefined>
export type ExtractionReviewFilter = "all" | "pending" | "accepted" | "rejected" | "needs-attention" | "ambiguous" | "unreconciled" | "ai-pending"
export type ExtractionReviewSourceFilter = Extract<ExtractionReviewFilter, "ambiguous" | "unreconciled" | "ai-pending">
export type ExtractionProposalAction = "accepting" | "rejecting" | "undoing"

export interface ExtractionReviewState {
  review: ExtractionReviewResponse | null
  proposalStatuses: ExtractionProposalStatusMap
  proposalCanUndo: Record<string, boolean | undefined>
  proposalActions: Record<string, ExtractionProposalAction | undefined>
  expandedProposalIds: Record<string, boolean | undefined>
  filter: ExtractionReviewFilter
  loading: boolean
  requestedSourceRowId?: string
  error: string | null
}

export type ExtractionReviewAction =
  | { type: "review_started"; sourceRowId?: string }
  | { type: "review_succeeded"; response: ExtractionReviewResponse; sourceRowId?: string }
  | { type: "review_failed"; error: string }
  | { type: "proposal_action_started"; proposalId: string; action: ExtractionProposalAction }
  | { type: "proposal_status"; proposalId: string; status: ExtractionProposalStatus }
  | { type: "proposal_statuses"; statuses: Record<string, { status: "pending" | ExtractionProposalStatus; canUndo: boolean }> }
  | { type: "proposal_action_failed"; proposalId: string; error: string }
  | { type: "toggle_expanded"; proposalId: string }
  | { type: "set_filter"; filter: ExtractionReviewFilter }

export function initialExtractionReviewState(): ExtractionReviewState {
  return {
    review: null,
    proposalStatuses: {},
    proposalCanUndo: {},
    proposalActions: {},
    expandedProposalIds: {},
    filter: "all",
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
        proposalCanUndo: { ...state.proposalCanUndo, [action.proposalId]: action.status === "accepted" },
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
    if (filter === "pending") return !status && proposal.operation !== "needs_human_review"
    if (filter === "accepted") return status === "accepted"
    if (filter === "rejected") return status === "rejected"
    return proposal.operation === "needs_human_review" || proposal.stale || !proposal.evidenceValid || !proposal.reconciled
  })
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
    && ["pending", "accepted", "rejected", "undone"].includes(String(summary.status))
    && typeof summary.canUndo === "boolean"
    && (summary.stale === undefined || typeof summary.stale === "boolean")
    && (summary.eligible === undefined || typeof summary.eligible === "boolean"))
}

function validReviewRun(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || !["queued", "running", "completed", "partial", "failed"].includes(String(value.status))) return false
  if (!isRecord(value.reviewTargeting) || !isStringArray(value.reviewTargeting.candidateRowIds)
    || (value.reviewTargeting.ambiguousRowIds !== undefined && !isStringArray(value.reviewTargeting.ambiguousRowIds))
    || (value.reviewTargeting.unreconciledRowIds !== undefined && !isStringArray(value.reviewTargeting.unreconciledRowIds))
    || typeof value.reviewTargeting.unreconciled !== "boolean") return false
  return ["requestKey", "leaseId", "leaseExpiresAt", "failureCode", "retryAfter", "updatedAt"]
    .every((key) => value[key] === undefined || typeof value[key] === "string")
}

/** Rejects malformed client payloads instead of allowing a partial provider response into review state. */
export function normalizeExtractionReviewResponse(value: unknown): ExtractionReviewResponse | null {
  if (!isRecord(value) || !["ai", "fallback", "not_required"].includes(String(value.mode))) return null
  if (value.snapshotMode !== undefined && value.snapshotMode !== "replace") return null
  if (typeof value.aiStatus !== "string" || typeof value.message !== "string") return null
  if (!isStringArray(value.sourceRowIds) || !isStringArray(value.remainingCandidateRowIds)) return null
  if (!Array.isArray(value.sourceRefs) || !Array.isArray(value.sourceRows) || !value.sourceRows.every(isSourceRow)) return null
  if (!Array.isArray(value.proposals) || !Array.isArray(value.rejectedProposals)) return null
  if (!validProposalStatuses(value.proposalStatuses) || !validReviewRun(value.reviewRun)
    || (value.auditEvents !== undefined && !Array.isArray(value.auditEvents))) return null
  return value as unknown as ExtractionReviewResponse
}

export function acceptAllValidatedProposalIds(
  proposals: readonly BulkProposal[],
  statuses: ExtractionProposalStatusMap,
): string[] {
  return proposals.filter((proposal) => (
    proposal.operation !== "needs_human_review"
    && proposal.confidence >= 0.9
    && proposal.evidenceValid === true
    && proposal.reconciled === true
    && proposal.stale !== true
    && !statuses[proposal.id]
  )).map((proposal) => proposal.id)
}
