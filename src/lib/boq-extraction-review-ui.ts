import type { ProposalOperation, ValidatedProposal } from './boq-extraction-proposals'

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
