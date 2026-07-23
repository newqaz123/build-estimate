import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractionReviewOutcomeMessage,
  extractionReviewOutcomeTitle,
  proposalCanBeAccepted,
  proposalIsHighConfidence,
  rejectionLabelGroups,
  selectExtractionReviewOutcome,
  selectExtractionReviewProgress,
  sourceReferenceLabel,
} from './boq-extraction-review-ui'
import type { ExtractionReviewResponse } from './boq-extraction-ai-review'
import type { ValidatedProposal } from './boq-extraction-proposals'

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
  assert.equal(extractionReviewOutcomeTitle(selectExtractionReviewOutcome(review)), 'Suggestions blocked by validation')
  assert.match(extractionReviewOutcomeMessage(review, 'validation-blocked'), /AI returned 3 suggestions, but none passed/)
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
  assert.equal(extractionReviewOutcomeTitle(selectExtractionReviewOutcome(review)), 'AI suggestions ready \u2014 some blocked')
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
