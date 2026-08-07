import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractionReviewOutcomeMessage,
  extractionReviewOutcomeTitle,
  proposalCanBeAccepted,
  proposalCanBeReviewedAndAdded,
  proposalManualAddMode,
  selectReviewTab,
  proposalIsHighConfidence,
  rejectionLabelGroups,
  selectExtractionReviewOutcome,
  selectExtractionReviewProgress,
  sourceReferenceLabel,
} from './boq-extraction-review-ui'
import type { ExtractionReviewResponse } from './boq-extraction-ai-review'
import { PROPOSAL_VALIDATION_FAILURE_CODES, type ProposalValidationFailureCode, type ProposalValidationSummary, type ValidatedProposal } from './boq-extraction-proposals'
import type { SourceBackedReviewDraft } from './boq-extraction-cell-mapping'

type ReviewableProposalFixture = Omit<ValidatedProposal, 'evidenceValid' | 'reconciled' | 'stale'> & {
  evidenceValid: boolean
  reconciled: boolean
  stale: boolean
}

function proposal(overrides: Partial<ReviewableProposalFixture> = {}): ReviewableProposalFixture {
  return {
    id: 'proposal-1',
    extractionRunId: 'run-1',
    operation: 'insert_missing_item',
    sourceRowIds: ['row-1'],
    targetItemIds: ['item-1'],
    affectedItemFingerprints: { 'item-1': 'fingerprint' },
    confidence: 0.9,
    explanation: 'The source row quotes separate material and labour values.',
    proposedItems: [],
    evidenceValid: true,
    reconciled: true,
    stale: false,
    ...overrides,
  }
}

test('only reconciled evidence-backed suggestions at 90% confidence are high-confidence', () => {
  assert.equal(proposalIsHighConfidence(proposal()), true)
  assert.equal(proposalIsHighConfidence(proposal({ confidence: 0.89 })), false)
  assert.equal(proposalIsHighConfidence(proposal({ evidenceValid: false })), false)
  assert.equal(proposalIsHighConfidence(proposal({ reconciled: false })), false)
})

test('human-review suggestions are surfaced but cannot be accepted as automatic corrections', () => {
  assert.equal(proposalCanBeAccepted(proposal()), true)
  assert.equal(proposalCanBeAccepted(proposal({ operation: 'needs_human_review' })), false)
  assert.equal(proposalCanBeAccepted(proposal({ operation: 'keep' })), false)
  assert.equal(proposalCanBeAccepted(proposal({ operation: 'separate_components' })), false)
  assert.equal(proposalCanBeAccepted(proposal({ stale: true })), false)
})

test('manual add is available for a pending no-target human-review proposal without a draft', () => {
  assert.equal(proposalCanBeReviewedAndAdded(proposal({
    operation: 'needs_human_review',
    targetItemIds: [],
    reviewDraft: undefined,
    stale: false,
  }), undefined, false), true)
})

test('manual add rejects target-based, stale, terminal, and read-only proposals', () => {
  const base = proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft: undefined })
  assert.equal(proposalCanBeReviewedAndAdded({ ...base, targetItemIds: ['item-1'] }, undefined, false), false)
  assert.equal(proposalCanBeReviewedAndAdded({ ...base, stale: true }, undefined, false), false)
  assert.equal(proposalCanBeReviewedAndAdded(base, 'skipped', false), false)
  assert.equal(proposalCanBeReviewedAndAdded(base, undefined, true), false)
})

test('manual add stays available for a needs_human_review proposal that already carries a non-stale review draft', () => {
  const reviewDraft: SourceBackedReviewDraft = {
    mapping: { sourceRowIds: ['row-1'] },
    resolvedValues: {},
    missingFields: [],
    sourceRowIds: ['row-1'],
    sourceRefs: [{ page: 1, table: 1, row: 1 }],
    section: null,
  }
  assert.equal(proposalCanBeReviewedAndAdded(
    proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft, stale: false }),
    undefined,
    false,
  ), true)
})

test('proposalManualAddMode selects the single editor for mapped-draft and one-row no-draft proposals', () => {
  const reviewDraft: SourceBackedReviewDraft = {
    mapping: { sourceRowIds: ['row-1'] },
    resolvedValues: {},
    missingFields: [],
    sourceRowIds: ['row-1'],
    sourceRefs: [{ page: 1, table: 1, row: 1 }],
    section: null,
  }
  // mapped draft → single (regardless of row count)
  assert.equal(proposalManualAddMode(
    proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft, sourceRowIds: ['row-1', 'row-2'], stale: false }),
  ), 'single')
  // no-draft one row → single
  assert.equal(proposalManualAddMode(
    proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft: undefined, sourceRowIds: ['row-1'], stale: false }),
  ), 'single')
})

test('proposalManualAddMode selects the batch editor for no-draft multi-row proposals', () => {
  assert.equal(proposalManualAddMode(
    proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft: undefined, sourceRowIds: ['row-1', 'row-2'], stale: false }),
  ), 'batch')
  assert.equal(proposalManualAddMode(
    proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft: undefined, sourceRowIds: ['row-1', 'row-2', 'row-3'], stale: false }),
  ), 'batch')
})

test('proposalManualAddMode returns null for non-human-review, empty-row, or target-bearing no-draft proposals', () => {
  // non-human-review operation → null
  assert.equal(proposalManualAddMode(
    proposal({ operation: 'insert_missing_item', targetItemIds: [], reviewDraft: undefined, sourceRowIds: ['row-1'] }),
  ), null)
  // empty source rows → null
  assert.equal(proposalManualAddMode(
    proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft: undefined, sourceRowIds: [] }),
  ), null)
  // no-draft with targets → null (not evidence-only)
  assert.equal(proposalManualAddMode(
    proposal({ operation: 'needs_human_review', targetItemIds: ['item-1'], reviewDraft: undefined, sourceRowIds: ['row-1'] }),
  ), null)
})

test('review presenter exposes the two durable tabs without changing acceptance gates', () => {
  const pending = proposal()
  const accepted = proposal({ id: 'accepted' })
  const review = { proposals: [pending, accepted] } as never
  assert.deepEqual(selectReviewTab({ review, proposalStatuses: { accepted: 'accepted' } }, 'needs-review').proposalIds, ['proposal-1'])
  assert.deepEqual(selectReviewTab({ review, proposalStatuses: { accepted: 'accepted' } }, 'history').proposalIds, ['accepted'])
})

test('review presenter exposes the two durable tabs without changing acceptance gates', () => {
  const pending = proposal()
  const accepted = proposal({ id: 'accepted' })
  const review = { proposals: [pending, accepted] } as never
  assert.deepEqual(selectReviewTab({ review, proposalStatuses: { accepted: 'accepted' } }, 'needs-review').proposalIds, ['proposal-1'])
  assert.deepEqual(selectReviewTab({ review, proposalStatuses: { accepted: 'accepted' } }, 'history').proposalIds, ['accepted'])
})

test('source references remain compact and auditable in the review panel', () => {
  assert.equal(sourceReferenceLabel({ sourceRowId: 'row-17', page: 2, table: 3, row: 5 }), 'p. 2 · table 3 · row 5')
})

function reviewResponse(overrides: Partial<ExtractionReviewResponse> = {}): ExtractionReviewResponse {
  return {
    snapshotMode: 'replace',
    mode: 'ai',
    aiStatus: 'completed',
    message: 'Test.',
    sourceRowIds: [],
    remainingCandidateRowIds: [],
    sourceRefs: [],
    sourceRows: [],
    proposals: [],
    rejectedProposals: [],
    reviewRun: {
      status: 'completed',
      reviewTargeting: { candidateRowIds: [], ambiguousRowIds: [], unreconciledRowIds: [], unreconciled: false },
    },
    ...overrides,
  }
}

test('outcome: not-required when there are zero candidate rows', () => {
  const review = reviewResponse({ reviewRun: { status: 'completed', reviewTargeting: { candidateRowIds: [], ambiguousRowIds: [], unreconciledRowIds: [], unreconciled: false } } })
  assert.equal(selectExtractionReviewOutcome(review), 'not-required')
  assert.equal(extractionReviewOutcomeTitle(selectExtractionReviewOutcome(review)), 'No review needed')
})

test('outcome: validation-blocked when all suggestions rejected', () => {
  const review = reviewResponse({
    proposals: [],
    reviewRun: {
      status: 'partial',
      validationSummary: { validatedProposalCount: 0, rejectedProposalCount: 3, rejectionCounts: { arithmetic_mismatch: 2, reconciliation_mismatch: 1 } },
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  assert.equal(selectExtractionReviewOutcome(review), 'validation-blocked')
  assert.equal(extractionReviewOutcomeTitle(selectExtractionReviewOutcome(review)), 'AI review completed \u2014 no safe corrections found')
  assert.match(extractionReviewOutcomeMessage(review, 'validation-blocked'), /The BOQ remains unchanged\. 3 AI responses did not pass safety checks/)
})

test('outcome: proposals-partially-blocked when some valid and some rejected', () => {
  const review = reviewResponse({
    proposals: [{ id: 'p1' } as ValidatedProposal],
    reviewRun: {
      status: 'partial',
      validationSummary: { validatedProposalCount: 1, rejectedProposalCount: 1, rejectionCounts: { arithmetic_mismatch: 1 } },
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  assert.equal(selectExtractionReviewOutcome(review), 'proposals-partially-blocked')
  assert.equal(extractionReviewOutcomeTitle(selectExtractionReviewOutcome(review)), 'AI suggestions ready \u2014 some not applied')
})

test('outcome: no-correction when completed with zero proposals and zero rejections', () => {
  const review = reviewResponse({
    proposals: [],
    reviewRun: {
      status: 'completed',
      validationSummary: { validatedProposalCount: 0, rejectedProposalCount: 0 },
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  assert.equal(selectExtractionReviewOutcome(review), 'no-correction')
  assert.equal(extractionReviewOutcomeTitle(selectExtractionReviewOutcome(review)), 'No correction recommended')
})

test('outcome: legacy-partial when partial without summary', () => {
  const review = reviewResponse({
    proposals: [],
    reviewRun: {
      status: 'partial',
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  assert.equal(selectExtractionReviewOutcome(review), 'legacy-partial')
  assert.match(extractionReviewOutcomeMessage(review, 'legacy-partial'), /Review partially completed/)
})

test('outcome: provider-unavailable when status is failed', () => {
  const review = reviewResponse({
    mode: 'fallback',
    reviewRun: {
      status: 'failed',
      failureCode: 'provider_failure',
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  assert.equal(selectExtractionReviewOutcome(review), 'provider-unavailable')
  assert.equal(extractionReviewOutcomeTitle(selectExtractionReviewOutcome(review)), 'AI review unavailable')
})

test('progress tracks candidate, reviewed, and remaining counts', () => {
  const review = reviewResponse({
    reviewRun: {
      status: 'completed',
      reviewedSourceRowIds: ['sr-1', 'sr-2'],
      reviewTargeting: { candidateRowIds: ['sr-1', 'sr-2', 'sr-3', 'sr-4', 'sr-5'], ambiguousRowIds: [], unreconciledRowIds: [], unreconciled: false },
    },
  })
  const progress = selectExtractionReviewProgress(review)
  assert.equal(progress.candidateCount, 5)
  assert.equal(progress.reviewedCount, 2)
  assert.equal(progress.remainingCount, 3)
  assert.match(progress.progressText, /2 of 5 candidate rows reviewed \u00b7 3 pending/)
})

test('rejection label groups aggregate codes into safe user-facing categories', () => {
  const groups = rejectionLabelGroups({ validatedProposalCount: 0, rejectedProposalCount: 3, rejectionCounts: { arithmetic_mismatch: 2, reconciliation_mismatch: 1 } })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, 'Arithmetic / reconciliation mismatch')
  assert.equal(groups[0].count, 3)
})

test('rejection label groups return empty for null summary', () => {
  assert.deepEqual(rejectionLabelGroups(null), [])
})

/* ------------------------------------------------------------------
 * Table-driven coverage: every production rejection code must map to a
 * known user-facing category and produce a neutral primary summary that
 * never falsely attributes all failures to source evidence.
 * ------------------------------------------------------------------ */

function summaryFor(code: ProposalValidationFailureCode, count = 1): ProposalValidationSummary {
  return { validatedProposalCount: 0, rejectedProposalCount: count, rejectionCounts: { [code]: count } }
}

const EVIDENCE_CODES: ProposalValidationFailureCode[] = [
  'missing_source_evidence', 'source_provenance_mismatch', 'target_source_mismatch',
  'unknown_source_row', 'unknown_candidate_item',
]

const NON_EVIDENCE_CODES = PROPOSAL_VALIDATION_FAILURE_CODES.filter((code) => !EVIDENCE_CODES.includes(code))

for (const code of PROPOSAL_VALIDATION_FAILURE_CODES) {
  test(`rejection label maps every production code: ${code}`, () => {
    const groups = rejectionLabelGroups(summaryFor(code))
    assert.equal(groups.length, 1)
    assert.notEqual(groups[0].label, 'Other validation issue')
    assert.equal(groups[0].count, 1)
  })
}

for (const code of PROPOSAL_VALIDATION_FAILURE_CODES) {
  test(`validation-blocked summary stays neutral for code: ${code}`, () => {
    const review = reviewResponse({
      reviewRun: {
        status: 'partial',
        validationSummary: summaryFor(code),
        reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
      },
    })
    assert.equal(selectExtractionReviewOutcome(review), 'validation-blocked')
    const message = extractionReviewOutcomeMessage(review, 'validation-blocked')
    assert.doesNotMatch(message, /did not reference valid source-backed evidence/i)
    assert.match(message, /safety checks/i)
  })

  test(`proposals-partially-blocked summary stays neutral for code: ${code}`, () => {
    const review = reviewResponse({
      proposals: [{ id: 'p1' } as ValidatedProposal],
      reviewRun: {
        status: 'partial',
        validationSummary: summaryFor(code),
        reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
      },
    })
    assert.equal(selectExtractionReviewOutcome(review), 'proposals-partially-blocked')
    const message = extractionReviewOutcomeMessage(review, 'proposals-partially-blocked')
    assert.doesNotMatch(message, /did not reference valid source-backed evidence/i)
    assert.match(message, /safety checks/i)
  })
}

for (const code of NON_EVIDENCE_CODES) {
  test(`validation-blocked message does not attribute non-evidence code to evidence: ${code}`, () => {
    const review = reviewResponse({
      reviewRun: {
        status: 'partial',
        validationSummary: summaryFor(code),
        reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
      },
    })
    const message = extractionReviewOutcomeMessage(review, 'validation-blocked')
    assert.doesNotMatch(message, /evidence/i)
  })
}

test('partially-blocked message uses singular "was" for one rejected response', () => {
  const review = reviewResponse({
    proposals: [{ id: 'p1' } as ValidatedProposal],
    reviewRun: {
      status: 'partial',
      validationSummary: summaryFor('arithmetic_mismatch', 1),
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  const message = extractionReviewOutcomeMessage(review, 'proposals-partially-blocked')
  assert.match(message, /1 response .* was not applied/)
  assert.doesNotMatch(message, /1 response .* were not applied/)
})

test('partially-blocked message uses plural "were" for multiple rejected responses', () => {
  const review = reviewResponse({
    proposals: [{ id: 'p1' } as ValidatedProposal],
    reviewRun: {
      status: 'partial',
      validationSummary: summaryFor('arithmetic_mismatch', 2),
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  const message = extractionReviewOutcomeMessage(review, 'proposals-partially-blocked')
  assert.match(message, /2 responses .* were not applied/)
})

test('validation-blocked message is grammatically correct for one rejected response', () => {
  const review = reviewResponse({
    reviewRun: {
      status: 'partial',
      validationSummary: summaryFor('arithmetic_mismatch', 1),
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  const message = extractionReviewOutcomeMessage(review, 'validation-blocked')
  assert.match(message, /1 AI response did not pass safety checks/)
})

test('validation-blocked message is grammatically correct for multiple rejected responses', () => {
  const review = reviewResponse({
    reviewRun: {
      status: 'partial',
      validationSummary: summaryFor('arithmetic_mismatch', 3),
      reviewTargeting: { candidateRowIds: ['sr-1'], ambiguousRowIds: ['sr-1'], unreconciledRowIds: [], unreconciled: false },
    },
  })
  const message = extractionReviewOutcomeMessage(review, 'validation-blocked')
  assert.match(message, /3 AI responses did not pass safety checks/)
})
