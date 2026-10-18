import { isReviewActionableOperation, type ProposalOperation, type ProposalValidationFailureCode, type ProposalValidationSummary, type ValidatedProposal } from './boq-extraction-proposals'
import type { ExtractionReviewResponse, ExtractionReviewSourceRow } from './boq-extraction-ai-review'

export { selectReviewTab } from './boq-extraction-review-state'
export type { ReviewTab } from './boq-extraction-review-state'

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
    && isReviewActionableOperation(proposal.operation)
    && proposal.stale !== true
}

export function proposalCanBeAccepted(proposal: ReviewableProposal): boolean {
  if (!isReviewActionableOperation(proposal.operation)) return false
  return proposalIsHighConfidence(proposal) || (
    proposal.evidenceValid === true
    && proposal.reconciled === true
    && proposal.stale !== true
  )
}

type SkippableProposal = Pick<ReviewableProposal, 'operation' | 'evidenceValid' | 'reconciled' | 'stale'>

/** Mirrors the server skip gate (`skipExtractionProposal`): only incomplete
 *  proposals — human review, unproven evidence, unreconciled arithmetic, or a
 *  stale target — may be marked "Not an item". The server refuses complete
 *  proposals with `not_incomplete`, so those are accepted or rejected instead.
 *  Lifecycle status and read-only protections stay with the caller. */
export function proposalCanBeSkipped(proposal: SkippableProposal): boolean {
  return proposal.operation === 'needs_human_review'
    || proposal.evidenceValid !== true
    || proposal.reconciled !== true
    || proposal.stale === true
}

function boqItemCount(count: number): string {
  return `${count} BOQ item${count === 1 ? '' : 's'}`
}

/** Deterministic Accept outcome derived only from the operation and the item
 *  counts the server mutation applies — never from AI prose. Insert adds every
 *  proposed item, replace swaps the targets for the proposed items, and remove
 *  deletes the targets without a replacement. Other operations return null. */
export function proposalAcceptOutcomeLabel(
  proposal: Pick<ValidatedProposal, 'operation' | 'proposedItems' | 'targetItemIds'>,
): string | null {
  const proposed = boqItemCount(proposal.proposedItems.length)
  const targeted = boqItemCount(proposal.targetItemIds.length)
  switch (proposal.operation) {
    case 'insert_missing_item': return `Add missing item · ${proposed}`
    case 'replace_item': return `Replace item · ${targeted} → ${proposed}`
    case 'remove_spurious_item': return `Remove non-item row · ${targeted}`
    default: return null
  }
}

/** Lifecycle statuses recorded after a reviewer resolves a proposal. Used to keep
 *  manual add gated to proposals that are still pending (no recorded outcome). */
type ProposalReviewLifecycleStatus = 'accepted' | 'rejected' | 'skipped' | 'superseded' | 'undone'

/** Minimal proposal surface the manual-add gate validates. Only the fields the
 *  predicate reads are required so the component can pass its in-flight shapes
 *  without constructing the full server proposal. */
type ReviewAddProposal = Pick<
  ValidatedProposal,
  'operation' | 'reviewDraft' | 'sourceRowIds' | 'targetItemIds' | 'stale'
>

/** Eligibility for the source-backed "Review & add" flow.
 *
 *  Only `needs_human_review` proposals qualify, and only while they are still
 *  pending (no recorded lifecycle status) and not read-only or stale. Structural
 *  eligibility is delegated to `proposalManualAddMode`, which returns `null`
 *  for non-eligible shapes. A non-null mode means the proposal is eligible for
 *  manual add.
 *
 *  This never broadens automatic **Accept**, which stays governed exclusively by
 *  `proposalCanBeAccepted` (and returns false for `needs_human_review`). */
export function proposalCanBeReviewedAndAdded(
  proposal: ReviewAddProposal,
  status: ProposalReviewLifecycleStatus | undefined,
  readOnly: boolean,
): boolean {
  if (readOnly || status !== undefined || proposal.stale === true) return false
  return proposalManualAddMode(proposal) !== null
}

/** Selects the manual-add editor mode for a `needs_human_review` proposal.
 *
 *  - A proposal carrying a server-mapped `reviewDraft` stays on the single
 *    `SourceBackedItemEditor` regardless of its row count.
 *  - A no-draft proposal is evidence-only (zero targets and at least one backing
 *    source row); a single backing row uses the single editor and multiple
 *    backing rows use the batch editor.
 *  - Non-human-review operations, empty source rows, and no-draft proposals with
 *    existing targets are not eligible and return `null`.
 *
 *  This is the single source of truth for single-vs-batch mount selection and
 *  for structural eligibility; `proposalCanBeReviewedAndAdded` derives from it. */
export function proposalManualAddMode(
  proposal: ReviewAddProposal,
): 'single' | 'batch' | null {
  if (proposal.operation !== 'needs_human_review') return null
  if (proposal.sourceRowIds.length === 0) return null
  if (proposal.reviewDraft) return 'single'
  if (proposal.targetItemIds.length > 0) return null
  return proposal.sourceRowIds.length > 1 ? 'batch' : 'single'
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
    case 'proposals-partially-blocked': return 'AI suggestions ready — some not applied'
    case 'validation-blocked': return 'AI review completed — no safe corrections found'
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
      return `${review.proposals.length} suggestion${review.proposals.length === 1 ? '' : 's'} ready to review. ${blocked} response${blocked === 1 ? '' : 's'} did not pass safety checks and ${blocked === 1 ? 'was' : 'were'} not applied.`
    }
    case 'validation-blocked': {
      const blocked = summary?.rejectedProposalCount ?? 0
      return `The BOQ remains unchanged. ${blocked} AI response${blocked === 1 ? '' : 's'} did not pass safety checks, so none could be applied.`
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
  unknown_candidate_item: 'Source evidence mismatch',
  duplicate_canonical_source: 'Duplicate / overlap conflict',
  spurious_removal_blocked: 'Unsafe shape or operation',
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

/* ------------------------------------------------------------------
 * Exception inbox projection
 * Pure helpers that classify leftover extraction suggestions into inbox
 * chips for the exception inbox. Rendering stays in the components; the
 * only gates reused here are the manual-add and skip eligibility predicates.
 * ------------------------------------------------------------------ */

export type InboxChip =
  | 'quote_total'
  | 'already_in_boq'
  | 'missing_item'
  | 'no_price'
  | 'needs_a_look'

export const INBOX_CHIP_LABEL: Record<InboxChip, string> = {
  quote_total: 'Quote total',
  already_in_boq: 'Already in BOQ',
  missing_item: 'Missing item',
  no_price: 'No price',
  needs_a_look: 'Needs a look',
}

export type InboxSourceRow = Pick<
  ExtractionReviewSourceRow,
  'sourceRowId' | 'rawText' | 'classification' | 'page' | 'table' | 'row'
>

const INBOX_SENTENCE_MAX_CHARS = 160
const INBOX_SENTENCE_BOUNDARY = /[.!?](?:\s|$)/
const QUOTE_TOTAL_TEXT_PATTERN = /overhead|profit|discount|sub-?total|payable|grand total|amount in words|\bvat\b/i
const UNPRICED_TEXT_PATTERN = /\bunpriced\b|incomplete pricing\b|incomplete price\b|no priced candidate\b|no numeric\b|lacks deterministic candidate\b|missing(?: source)? price\b|\bno price\b/i
const UNPRICED_MISSING_FIELDS = new Set([
  'rate', 'total', 'materialRate', 'materialTotal', 'labourRate', 'labourTotal', 'amount',
])

/** First sentence of an inbox row's text, capped at maxChars (default 160). */
export function firstInboxSentence(text: string, maxChars: number = INBOX_SENTENCE_MAX_CHARS): string {
  const trimmed = text.trim()
  const boundary = trimmed.search(INBOX_SENTENCE_BOUNDARY)
  const sentence = boundary === -1 ? trimmed : trimmed.slice(0, boundary + 1)
  return sentence.slice(0, Math.max(0, maxChars))
}

function backingInboxRows(
  sourceRowIds: readonly string[],
  sourceRows: readonly InboxSourceRow[],
): InboxSourceRow[] {
  const wanted = new Set(sourceRowIds)
  return sourceRows.filter((row) => wanted.has(row.sourceRowId))
}

/** True when the proposal points at a commercial summary/tax row instead of a
 *  priced work item, so it must not be mislabeled "No price" or "Missing item". */
export function isQuoteTotalProposal(
  proposal: Pick<ValidatedProposal, 'explanation' | 'sourceRowIds' | 'sourceRowSuggestions'>,
  sourceRows: readonly InboxSourceRow[],
): boolean {
  if (proposal.sourceRowSuggestions?.some((suggestion) => suggestion.reasonCode === 'summary_or_tax')) return true
  const rows = backingInboxRows(proposal.sourceRowIds, sourceRows)
  if (rows.some((row) => row.classification === 'total')) return true
  if (QUOTE_TOTAL_TEXT_PATTERN.test(proposal.explanation)) return true
  return rows.some((row) => QUOTE_TOTAL_TEXT_PATTERN.test(row.rawText))
}

function hasUnpricedInboxText(
  proposal: Pick<ValidatedProposal, 'explanation' | 'reviewDraft' | 'sourceRowIds'>,
  sourceRows: readonly InboxSourceRow[],
): boolean {
  if (proposal.reviewDraft?.missingFields.some((field) => UNPRICED_MISSING_FIELDS.has(field))) return true
  if (UNPRICED_TEXT_PATTERN.test(proposal.explanation)) return true
  return backingInboxRows(proposal.sourceRowIds, sourceRows)
    .some((row) => UNPRICED_TEXT_PATTERN.test(row.rawText))
}

/** Single chip for an inbox row. Precedence: quote totals and mapped targets
 *  first; unpriced text then beats the add gate so unpriced leftovers default
 *  to "No price" instead of inviting a manual add. */
export function inboxChipForProposal(
  proposal: Pick<
    ValidatedProposal,
    'operation' | 'reviewDraft' | 'sourceRowIds' | 'targetItemIds' | 'stale' | 'explanation' | 'sourceRowSuggestions'
  >,
  status: ProposalReviewLifecycleStatus | undefined,
  readOnly: boolean,
  sourceRows: readonly InboxSourceRow[],
): InboxChip {
  if (isQuoteTotalProposal(proposal, sourceRows)) return 'quote_total'
  if (proposal.targetItemIds.length > 0) return 'already_in_boq'
  const canAdd = proposalCanBeReviewedAndAdded(proposal, status, readOnly)
  if (hasUnpricedInboxText(proposal, sourceRows) || (proposal.operation === 'needs_human_review' && !canAdd)) return 'no_price'
  if (canAdd) return 'missing_item'
  return 'needs_a_look'
}

/** Inbox row title: the backing source row's raw text when available, else the
 *  capped first sentence of the AI explanation. */
export function inboxRowTitle(
  proposal: Pick<ValidatedProposal, 'explanation' | 'sourceRowIds'>,
  sourceRows: readonly InboxSourceRow[],
): string {
  const backingRawText = backingInboxRows(proposal.sourceRowIds, sourceRows)
    .map((row) => row.rawText.trim())
    .find((rawText) => rawText.length > 0)
  return backingRawText ?? firstInboxSentence(proposal.explanation)
}

export function inboxPendingCount(
  proposals: readonly Pick<ValidatedProposal, 'id' | 'stale'>[],
  statuses: Readonly<Record<string, { status?: string } | string | undefined>>,
): number {
  return proposals.filter((proposal) => proposal.stale !== true && !isResolvedInboxStatus(statuses[proposal.id])).length
}

function isResolvedInboxStatus(entry: { status?: string } | string | undefined): boolean {
  if (entry === undefined) return false
  if (typeof entry === 'string') return entry.length > 0
  return typeof entry.status === 'string' && entry.status.length > 0
}

/** Ids of pending rows eligible for the shared unpriced grouping; only
 *  meaningful when at least two rows qualify, otherwise []. A chip alone never
 *  authorizes skip: each row must also pass `proposalCanBeSkipped`, otherwise
 *  the server rejects it and halts the sequential group. */
export function unpricedInboxGroupIds(
  rows: readonly {
    id: string
    chip: InboxChip
    proposal: SkippableProposal
    status: ProposalReviewLifecycleStatus | undefined
  }[],
): string[] {
  const ids = rows
    .filter((row) => (row.chip === 'no_price' || row.chip === 'quote_total')
      && row.status === undefined
      && proposalCanBeSkipped(row.proposal))
    .map((row) => row.id)
  return ids.length >= 2 ? ids : []
}
