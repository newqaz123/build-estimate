import type { ExtractionReviewResponse } from "./boq-extraction-ai-review"
import type { ProposalOperation } from "./boq-extraction-proposals"

export type ExtractionProposalStatus = "accepted" | "rejected" | "undone"
export type ExtractionProposalStatusMap = Record<string, ExtractionProposalStatus | undefined>

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

/** Rejects malformed client payloads instead of allowing a partial provider response into review state. */
export function normalizeExtractionReviewResponse(value: unknown): ExtractionReviewResponse | null {
  if (!isRecord(value) || !["ai", "fallback", "not_required"].includes(String(value.mode))) return null
  if (typeof value.aiStatus !== "string" || typeof value.message !== "string") return null
  if (!isStringArray(value.sourceRowIds) || !isStringArray(value.remainingCandidateRowIds)) return null
  if (!Array.isArray(value.sourceRefs) || !Array.isArray(value.sourceRows) || !value.sourceRows.every(isSourceRow)) return null
  if (!Array.isArray(value.proposals) || !Array.isArray(value.rejectedProposals)) return null
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
