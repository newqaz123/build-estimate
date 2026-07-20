import type { Boq, BoqSection } from './boq-schema'
import { calculateBoqTotals } from './boq-pricing'
import { stableCanonicalJson, type BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3, DerivedPricedItemV3 } from './boq-extraction-schema'
import {
  applyValidatedProposal,
  fingerprintCanonicalSections,
  undoAcceptedProposal,
  validateProposal,
  type ExtractionProposal,
  type ProposalAcceptanceAudit,
  type ProposalSourceEvidence,
  type ProposalValidationFailureCode,
  type ProposedExtractionItem,
  type ValidatedProposal,
} from './boq-extraction-proposals'

export type ExtractionProposalAuditStatus = 'accepted' | 'rejected'

/** Immutable audit payload stored with a proposal action, not with source evidence. */
export interface ExtractionProposalAudit {
  auditId: string
  proposalId: string
  extractionRunId: string
  status: ExtractionProposalAuditStatus
  actorId: string
  timestamp: string
  operation: ExtractionProposal['operation']
  targetItemIds: string[]
  affectedItemFingerprints: Record<string, string>
  confidence: number
  explanation: string
  sourceRowIds: string[]
  sourceRefs: Array<{ sourceRowId: string; page: number; table: number; row: number }>
  proposedItems: ProposedExtractionItem[]
  evidenceValid?: boolean
  reconciled?: boolean
  stale?: boolean
  beforeSections: BoqSection[]
  beforeSectionsFingerprint: string
  afterSections: BoqSection[]
  afterSectionsFingerprint: string
  /** Exact BOQ returned by the initial accepted action; never rebuild retries from current metadata. */
  resultBoq?: Boq
}

/** Append-only event written separately from the accepted proposal audit. */
export interface ExtractionProposalUndoEvent {
  eventId: string
  proposalId: string
  extractionRunId: string
  status: 'undone'
  actorId: string
  timestamp: string
  sourceRowIds: string[]
  sourceRefs: Array<{ sourceRowId: string; page: number; table: number; row: number }>
  beforeSections: BoqSection[]
  beforeSectionsFingerprint: string
  afterSections: BoqSection[]
  afterSectionsFingerprint: string
  resultTotalItems: number
  resultGrandTotal: number
  /** Exact BOQ returned by the initial undo action; never rebuild retries from current metadata. */
  resultBoq?: Boq
}

export type ProposalAcceptanceResult =
  | { kind: 'accepted'; boq: Boq; audit: ExtractionProposalAudit }
  | { kind: 'already_accepted'; boq: Boq; audit: ExtractionProposalAudit }
  | { kind: 'rejected'; audit: ExtractionProposalAudit }
  | { kind: 'invalid'; code: ProposalValidationFailureCode | 'needs_human_review' }

export type ProposalUndoResult =
  | { kind: 'undone'; boq: Boq; audit: ExtractionProposalUndoEvent }
  | { kind: 'conflict' }
  | { kind: 'not_accepted' }

function sourceEvidence(run: BoqExtractionRun): Record<string, ProposalSourceEvidence> {
  const evidence: Record<string, ProposalSourceEvidence> = {}
  for (const item of run.sections.flatMap((section) => section.items)) {
    if (item.pricingRole === 'bundle_child' || item.sourceRowIds.length !== 1) continue
    const priced = item as DerivedPricedItemV3
    const sourceRowId = priced.sourceRowIds[0]
    const current = evidence[sourceRowId]
    evidence[sourceRowId] = { quotedTotal: (current?.quotedTotal ?? 0) + priced.total }
    if (priced.sourceCosts) {
      evidence[sourceRowId].components = {
        material: { ...priced.sourceCosts.material },
        labour: { ...priced.sourceCosts.labour },
      }
    }
  }
  return evidence
}

function sourceRefs(rows: readonly BoqSourceRowV3[], ids: readonly string[]) {
  const known = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = known.get(id)
    return row ? [{ sourceRowId: id, page: row.page, table: row.table, row: row.row }] : []
  })
}

function withTotals(boq: Boq, sections: BoqSection[]): Boq {
  const totals = calculateBoqTotals(sections)
  return { ...boq, sections, totalItems: totals.totalItems, grandTotal: totals.grandTotal }
}

function toAudit(
  input: { proposal: ExtractionProposal; actorId: string; now: string; sourceRows: readonly BoqSourceRowV3[] },
  status: ExtractionProposalAuditStatus,
  state: ProposalAcceptanceAudit & { sections?: BoqSection[] },
  resultBoq?: Boq,
): ExtractionProposalAudit {
  const afterSections = state.sections ?? state.beforeSections
  const proposal = input.proposal as ExtractionProposal & Partial<ValidatedProposal>
  return {
    auditId: `${input.proposal.id}:${input.now}`,
    proposalId: input.proposal.id,
    extractionRunId: input.proposal.extractionRunId,
    status,
    actorId: input.actorId,
    timestamp: input.now,
    operation: input.proposal.operation,
    targetItemIds: [...input.proposal.targetItemIds],
    affectedItemFingerprints: { ...input.proposal.affectedItemFingerprints },
    confidence: input.proposal.confidence,
    explanation: input.proposal.explanation,
    sourceRowIds: [...input.proposal.sourceRowIds],
    sourceRefs: sourceRefs(input.sourceRows, input.proposal.sourceRowIds),
    proposedItems: structuredClone(input.proposal.proposedItems),
    ...(proposal.evidenceValid === undefined ? {} : { evidenceValid: proposal.evidenceValid }),
    ...(proposal.reconciled === undefined ? {} : { reconciled: proposal.reconciled }),
    ...(proposal.stale === undefined ? {} : { stale: proposal.stale }),
    beforeSections: structuredClone(state.beforeSections),
    beforeSectionsFingerprint: state.beforeSectionsFingerprint,
    afterSections: structuredClone(afterSections),
    afterSectionsFingerprint: state.afterSectionsFingerprint,
    ...(resultBoq ? { resultBoq: structuredClone(resultBoq) } : {}),
  }
}

/** Server-side validation shared by Accept and Reject; neither trusts client arithmetic. */
export function validateExtractionProposal(
  boq: Boq,
  run: BoqExtractionRun,
  sourceRows: readonly BoqSourceRowV3[],
  proposal: ExtractionProposal,
): { valid: true; proposal: ValidatedProposal } | { valid: false; code: ProposalValidationFailureCode } {
  if (run.boqId !== boq.id || run.status !== 'ready' || proposal.extractionRunId !== run.id) {
    return { valid: false, code: 'run_identity_mismatch' }
  }
  return validateProposal(proposal, {
    extractionRunId: run.id,
    sourceRows,
    sourceEvidence: sourceEvidence(run),
    sections: boq.sections,
  })
}

export function proposalMatchesAudit(proposal: ExtractionProposal, audit: ExtractionProposalAudit): boolean {
  const validated = proposal as ExtractionProposal & Partial<ValidatedProposal>
  return stableCanonicalJson({
    id: proposal.id,
    extractionRunId: proposal.extractionRunId,
    operation: proposal.operation,
    sourceRowIds: proposal.sourceRowIds,
    targetItemIds: proposal.targetItemIds,
    affectedItemFingerprints: proposal.affectedItemFingerprints,
    confidence: proposal.confidence,
    explanation: proposal.explanation,
    proposedItems: proposal.proposedItems,
    evidenceValid: validated.evidenceValid ?? true,
    reconciled: validated.reconciled ?? true,
    stale: validated.stale ?? false,
  }) === stableCanonicalJson({
    id: audit.proposalId,
    extractionRunId: audit.extractionRunId,
    operation: audit.operation,
    sourceRowIds: audit.sourceRowIds,
    targetItemIds: audit.targetItemIds,
    affectedItemFingerprints: audit.affectedItemFingerprints,
    confidence: audit.confidence,
    explanation: audit.explanation,
    proposedItems: audit.proposedItems,
    evidenceValid: audit.evidenceValid ?? true,
    reconciled: audit.reconciled ?? true,
    stale: audit.stale ?? false,
  })
}

export function acceptExtractionProposal(input: {
  boq: Boq
  run: BoqExtractionRun
  sourceRows: readonly BoqSourceRowV3[]
  proposal: ExtractionProposal
  actorId: string
  now: string
  existingAudit: ExtractionProposalAudit | null
}): ProposalAcceptanceResult {
  if (input.existingAudit) {
    if (!proposalMatchesAudit(input.proposal, input.existingAudit)) return { kind: 'invalid', code: 'run_identity_mismatch' }
    if (input.existingAudit.status === 'accepted') {
      if (!input.existingAudit.resultBoq) return { kind: 'invalid', code: 'run_identity_mismatch' }
      const replay = structuredClone(input.existingAudit.resultBoq)
      return { kind: 'already_accepted', boq: replay, audit: input.existingAudit }
    }
    if (input.existingAudit.status === 'rejected') return { kind: 'rejected', audit: input.existingAudit }
    return { kind: 'invalid', code: 'stale_item' }
  }
  const validation = validateExtractionProposal(input.boq, input.run, input.sourceRows, input.proposal)
  if (!validation.valid) return { kind: 'invalid', code: validation.code }
  if (validation.proposal.operation === 'needs_human_review') return { kind: 'invalid', code: 'needs_human_review' }
  try {
    const accepted = applyValidatedProposal(input.boq.sections, validation.proposal)
    const next = withTotals(input.boq, accepted.sections)
    const validatedInput = { ...input, proposal: validation.proposal }
    return {
      kind: 'accepted',
      boq: next,
      audit: toAudit(validatedInput, 'accepted', { ...accepted.audit, sections: accepted.sections }, next),
    }
  } catch {
    return { kind: 'invalid', code: 'stale_item' }
  }
}

export function rejectExtractionProposal(input: {
  boq?: Boq
  proposal: ExtractionProposal
  actorId: string
  now: string
  existingAudit: ExtractionProposalAudit | null
  sourceRows?: readonly BoqSourceRowV3[]
}): { kind: 'rejected'; audit: ExtractionProposalAudit } | { kind: 'already_recorded'; audit: ExtractionProposalAudit } | { kind: 'invalid'; code: 'run_identity_mismatch' } {
  if (input.existingAudit) {
    if (!proposalMatchesAudit(input.proposal, input.existingAudit)) return { kind: 'invalid', code: 'run_identity_mismatch' }
    return { kind: 'already_recorded', audit: input.existingAudit }
  }
  const beforeSections = structuredClone(input.boq?.sections ?? [])
  // A rejection has no BOQ mutation, but records the exact proposal and action.
  const audit: ExtractionProposalAudit = {
    auditId: `${input.proposal.id}:${input.now}`,
    proposalId: input.proposal.id,
    extractionRunId: input.proposal.extractionRunId,
    status: 'rejected', actorId: input.actorId, timestamp: input.now,
    operation: input.proposal.operation, confidence: input.proposal.confidence, explanation: input.proposal.explanation,
    targetItemIds: [...input.proposal.targetItemIds], affectedItemFingerprints: { ...input.proposal.affectedItemFingerprints },
    sourceRowIds: [...input.proposal.sourceRowIds], sourceRefs: sourceRefs(input.sourceRows ?? [], input.proposal.sourceRowIds),
    proposedItems: structuredClone(input.proposal.proposedItems),
    ...((input.proposal as Partial<ValidatedProposal>).evidenceValid === undefined ? {} : { evidenceValid: (input.proposal as Partial<ValidatedProposal>).evidenceValid }),
    ...((input.proposal as Partial<ValidatedProposal>).reconciled === undefined ? {} : { reconciled: (input.proposal as Partial<ValidatedProposal>).reconciled }),
    ...((input.proposal as Partial<ValidatedProposal>).stale === undefined ? {} : { stale: (input.proposal as Partial<ValidatedProposal>).stale }),
    beforeSections, afterSections: structuredClone(beforeSections),
    beforeSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
    afterSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
  }
  return { kind: 'rejected', audit }
}

export function undoExtractionProposal(input: {
  boq: Boq
  audit: ExtractionProposalAudit
  actorId: string
  now: string
  sourceRefs?: ExtractionProposalUndoEvent['sourceRefs']
}): ProposalUndoResult {
  if (input.audit.status !== 'accepted') return { kind: 'not_accepted' }
  try {
    const sections = undoAcceptedProposal(input.boq.sections, {
      proposalId: input.audit.proposalId,
      operation: input.audit.operation,
      beforeSections: input.audit.beforeSections,
      beforeSectionsFingerprint: input.audit.beforeSectionsFingerprint,
      afterSectionsFingerprint: input.audit.afterSectionsFingerprint,
    })
    const next = withTotals(input.boq, sections)
    return {
      kind: 'undone',
      boq: next,
      audit: {
        eventId: `${input.audit.proposalId}:undo:${input.now}`,
        proposalId: input.audit.proposalId,
        extractionRunId: input.audit.extractionRunId,
        status: 'undone',
        actorId: input.actorId,
        timestamp: input.now,
        sourceRowIds: [...input.audit.sourceRowIds],
        sourceRefs: structuredClone(input.sourceRefs ?? []),
        beforeSections: structuredClone(input.boq.sections),
        beforeSectionsFingerprint: fingerprintCanonicalSections(input.boq.sections),
        afterSections: structuredClone(next.sections),
        afterSectionsFingerprint: fingerprintCanonicalSections(next.sections),
        resultTotalItems: next.totalItems,
        resultGrandTotal: next.grandTotal,
        resultBoq: structuredClone(next),
      },
    }
  } catch {
    return { kind: 'conflict' }
  }
}
