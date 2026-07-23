import type { ProposalOperation, ProposalValidationFailureCode, ProposalValidationSummary, ValidatedProposal } from './boq-extraction-proposals'
import type { ExtractionReviewResponse } from './boq-extraction-ai-review'

type ReviewableProposal = Pick<ValidatedProposal, 'confidence'> & {
  operation: ProposalOperation
  evidenceValid: boolean
  reconciled: boolean
  stale: boolean
}

/** Mirrors the server acceptance gate so the UI never labels an unsafe suggestion as bulk-applicable. */
export function proposalIsHighConfidence(proposal: ReviewableProposal): boolean {
  return proposal.confidence >= 0.9
    && proposal.evidenceValid === true
    && proposal.reconciled === true
    && proposal.stale !== true
}

export function proposalCanBeAccepted(proposal: ReviewableProposal): boolean {
  if (proposal.operation === 'needs_human_review') return false
  return proposalIsHighConfidence(proposal) || (
    proposal.evidenceValid === true
    && proposal.reconciled === true
    && proposal.stale !== true
  )
}

export function sourceReferenceLabel(reference: { sourceRowId?: string; page: number; table: number; row: number }): string {
  return `p. ${reference.page} · table ${reference.table} · row ${reference.row}`
}

export type ExtractionReviewOutcome =
  | 'not-required'
  | 'queued-or-running'
  | 'provider-unavailable'
  | 'proposals-ready'
  | 'proposals-partially-blocked'
  | 'validation-blocked'
  | 'no-correction'
  | 'pending-follow-up'
  | 'legacy-partial'

export interface ExtractionReviewProgress {
  candidateCount: number
  reviewedCount: number
  remainingCount: number
  progressText: string
}

interface ReviewFacts {
  candidateCount: number
  proposalCount: number
  status: string
  validationSummary: ProposalValidationSummary | null
  remainingCount: number
}

function reviewFacts(review: ExtractionReviewResponse): ReviewFacts {
  const reviewRun = review.reviewRun
  const candidateRowIds = reviewRun?.reviewTargeting?.candidateRowIds ?? []
  return {
    candidateCount: candidateRowIds.length,
    proposalCount: review.proposals.length,
    status: reviewRun?.status ?? '',
    validationSummary: reviewRun?.validationSummary ?? null,
    remainingCount: review.remainingCandidateRowIds.length,
  }
}

export function selectExtractionReviewProgress(review: ExtractionReviewResponse): ExtractionReviewProgress {
  const reviewRun = review.reviewRun
  const candidateRowIds = reviewRun?.reviewTargeting?.candidateRowIds ?? []
  const reviewedSourceRowIds = new Set(reviewRun?.reviewedSourceRowIds ?? [])
  const candidateCount = candidateRowIds.length
  const reviewedCount = candidateRowIds.filter((id) => reviewedSourceRowIds.has(id)).length
  const remainingCount = candidateRowIds.filter((id) => !reviewedSourceRowIds.has(id)).length
  const progressText = candidateCount > 0
    ? `${reviewedCount} of ${candidateCount} candidate row${candidateCount === 1 ? '' : 's'} reviewed · ${remainingCount} pending.`
    : ''
  return { candidateCount, reviewedCount, remainingCount, progressText }
}

export function selectExtractionReviewOutcome(review: ExtractionReviewResponse): ExtractionReviewOutcome {
  const facts = reviewFacts(review)
  if (facts.candidateCount === 0) return 'not-required'
  if (['queued', 'running'].includes(facts.status)) return 'queued-or-running'
  if (facts.status === 'failed') return 'provider-unavailable'
  const hasSummary = facts.validationSummary !== null
  const blockedCount = facts.validationSummary?.rejectedProposalCount ?? 0
  if (facts.proposalCount > 0 && blockedCount > 0) return 'proposals-partially-blocked'
  if (facts.proposalCount === 0 && blockedCount > 0) return 'validation-blocked'
  if (facts.proposalCount === 0 && facts.status === 'partial' && !hasSummary) return 'legacy-partial'
  if (facts.proposalCount === 0 && blockedCount === 0 && facts.remainingCount > 0) return 'pending-follow-up'
  if (facts.proposalCount === 0 && blockedCount === 0) return 'no-correction'
  return 'proposals-ready'
}

export function extractionReviewOutcomeTitle(outcome: ExtractionReviewOutcome): string {
  switch (outcome) {
    case 'not-required': return 'No review needed'
    case 'queued-or-running': return 'AI review in progress'
    case 'provider-unavailable': return 'AI review unavailable'
    case 'proposals-ready': return 'AI suggestions ready'
    case 'proposals-partially-blocked': return 'AI suggestions ready — some blocked'
    case 'validation-blocked': return 'Suggestions blocked by validation'
    case 'no-correction': return 'No correction recommended'
    case 'pending-follow-up': return 'Review partially completed'
    case 'legacy-partial': return 'Review partially completed'
  }
}

export function extractionReviewOutcomeMessage(review: ExtractionReviewResponse, outcome: ExtractionReviewOutcome): string {
  const summary = review.reviewRun?.validationSummary ?? null
  switch (outcome) {
    case 'not-required': return 'No ambiguous, unreconciled, or compound rows require review.'
    case 'queued-or-running': return review.reviewRun?.status === 'queued' ? 'Extraction review is queued.' : 'Extraction review is running.'
    case 'provider-unavailable': return 'AI review is temporarily unavailable. The deterministic extraction remains unchanged.'
    case 'proposals-ready': return 'Saved extraction suggestions loaded for review.'
    case 'proposals-partially-blocked': {
      const blocked = summary?.rejectedProposalCount ?? 0
      return `${review.proposals.length} suggestion${review.proposals.length === 1 ? '' : 's'} ready; ${blocked} blocked by validation.`
    }
    case 'validation-blocked': {
      const blocked = summary?.rejectedProposalCount ?? 0
      return `AI returned ${blocked} suggestion${blocked === 1 ? '' : 's'}, but none passed evidence and reconciliation checks. The BOQ remains unchanged.`
    }
    case 'no-correction': return 'No correction recommended for the reviewed rows.'
    case 'pending-follow-up': return 'Review partially completed. Some candidate rows remain unreviewed — recheck to continue.'
    case 'legacy-partial': return 'Review partially completed. Some candidate rows remain unreviewed — recheck to continue.'
  }
}

/** Maps allowlisted validation failure codes to safe user-facing groups.
 *  Never echoes an unknown stored string. */
const REJECTION_LABELS: Partial<Record<ProposalValidationFailureCode, string>> = {
  missing_source_evidence: 'Source evidence mismatch',
  source_provenance_mismatch: 'Source evidence mismatch',
  target_source_mismatch: 'Source evidence mismatch',
  unknown_source_row: 'Source evidence mismatch',
  arithmetic_mismatch: 'Arithmetic / reconciliation mismatch',
  reconciliation_mismatch: 'Arithmetic / reconciliation mismatch',
  invalid_shape: 'Unsafe shape or operation',
  invalid_operation_shape: 'Unsafe shape or operation',
  unknown_operation: 'Unsafe shape or operation',
  invalid_bundle: 'Unsafe shape or operation',
  invented_component_price: 'Unsafe shape or operation',
  invalid_confidence: 'Unsafe shape or operation',
  run_identity_mismatch: 'Unsafe shape or operation',
  stale_item: 'Stale target',
  target_state_mismatch: 'Stale target',
  unknown_target_item: 'Stale target',
  duplicate_proposal: 'Duplicate / overlap conflict',
  duplicate_item_id: 'Duplicate / overlap conflict',
  duplicate_source_row: 'Duplicate / overlap conflict',
  overlapping_target: 'Duplicate / overlap conflict',
  overlapping_source_row: 'Duplicate / overlap conflict',
}

export interface RejectionLabelGroup {
  label: string
  count: number
}

export function rejectionLabelGroups(summary: ProposalValidationSummary | null): RejectionLabelGroup[] {
  if (!summary?.rejectionCounts) return []
  const groups = new Map<string, number>()
  for (const [code, count] of Object.entries(summary.rejectionCounts)) {
    const label = REJECTION_LABELS[code as ProposalValidationFailureCode] ?? 'Other validation issue'
    groups.set(label, (groups.get(label) ?? 0) + count)
  }
  return [...groups.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
}
