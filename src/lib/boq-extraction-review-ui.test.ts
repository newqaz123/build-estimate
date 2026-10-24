import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractionReviewOutcomeMessage,
  extractionReviewOutcomeTitle,
  firstInboxSentence,
  inboxChipForProposal,
  inboxPendingCount,
  inboxRowTitle,
  proposalAcceptOutcomeLabel,
  proposalCanBeAccepted,
  proposalCanBeReviewedAndAdded,
  proposalCanBeSkipped,
  proposalManualAddMode,
  selectReviewTab,
  proposalIsHighConfidence,
  rejectionLabelGroups,
  selectExtractionReviewOutcome,
  selectExtractionReviewProgress,
  sourceReferenceLabel,
  unpricedInboxGroupIds,
  type InboxSourceRow,
} from './boq-extraction-review-ui'
import type { ExtractionReviewResponse } from './boq-extraction-ai-review'
import { skipExtractionProposal } from './boq-extraction-acceptance'
import { PROPOSAL_VALIDATION_FAILURE_CODES, applyValidatedProposal, fingerprintCanonicalItem, type ExtractionProposal, type ProposalValidationFailureCode, type ProposalValidationSummary, type ProposedExtractionItem, type ValidatedProposal } from './boq-extraction-proposals'
import type { SourceBackedReviewDraft } from './boq-extraction-cell-mapping'
import type { Boq, BoqPricedItem, BoqSection } from './boq-schema'

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

/* ------------------------------------------------------------------
 * Exception inbox projection: chips, titles, pending counts, and
 * unpriced grouping for leftover extraction suggestions.
 * ------------------------------------------------------------------ */

test('firstInboxSentence keeps the first sentence and caps length', () => {
  assert.equal(
    firstInboxSentence('No price on this row. Extra detail follows.'),
    'No price on this row.',
  )
  assert.equal(firstInboxSentence('x'.repeat(200)).length, 160)
})

test('inbox chips follow quote / target / add-gate / unpriced precedence', () => {
  const rows = [
    {
      sourceRowId: 'row-1',
      rawText: 'A.1 Concrete Curb',
      classification: 'item' as const,
      page: 2,
      table: 1,
      row: 3,
    },
  ]
  const human = proposal({
    operation: 'needs_human_review',
    targetItemIds: [],
    reviewDraft: undefined,
    explanation: 'The row is an unpriced layer entry.',
  })
  assert.equal(inboxChipForProposal(human, undefined, false, rows), 'no_price')

  assert.equal(
    inboxChipForProposal(
      proposal({
        operation: 'needs_human_review',
        targetItemIds: [],
        reviewDraft: undefined,
        explanation: 'Missing priced line.',
      }),
      undefined,
      false,
      rows,
    ),
    'missing_item',
  )

  assert.equal(
    inboxChipForProposal(
      { ...human, targetItemIds: ['item-1'] },
      undefined,
      false,
      rows,
    ),
    'already_in_boq',
  )

  assert.equal(
    inboxChipForProposal(
      proposal({
        operation: 'needs_human_review',
        targetItemIds: [],
        explanation: 'OVERHEAD & PROFIT commercial total.',
        sourceRowSuggestions: [
          {
            sourceRowId: 'row-1',
            suggestedAction: 'ignore',
            reasonCode: 'summary_or_tax',
            reason: 'summary',
            confidence: 0.9,
          },
        ],
      }),
      undefined,
      false,
      rows,
    ),
    'quote_total',
  )
})

test('unpriced price wording beats the manual add gate', () => {
  const rows = [{
    sourceRowId: 'row-1',
    rawText: 'A.1 Concrete Curb',
    classification: 'item' as const,
    page: 2,
    table: 1,
    row: 3,
  }]
  const draft: SourceBackedReviewDraft = {
    mapping: { sourceRowIds: ['row-1'] },
    resolvedValues: {},
    missingFields: [],
    sourceRowIds: ['row-1'],
    sourceRefs: [{ page: 2, table: 1, row: 3 }],
    section: null,
  }
  for (const explanation of ['Missing source price.', 'No price is shown.', 'Incomplete price data.']) {
    assert.equal(
      inboxChipForProposal(
        proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft: draft, explanation }),
        undefined,
        false,
        rows,
      ),
      'no_price',
      explanation,
    )
  }
})

test('missing price fields mark a source-backed draft as no price', () => {
  const draft: SourceBackedReviewDraft = {
    mapping: { sourceRowIds: ['row-1'] },
    resolvedValues: { description: 'Concrete Curb', unit: 'm', quantity: 1 },
    missingFields: ['rate'],
    sourceRowIds: ['row-1'],
    sourceRefs: [{ page: 2, table: 1, row: 3 }],
    section: null,
  }
  assert.equal(
    inboxChipForProposal(
      proposal({
        operation: 'needs_human_review',
        targetItemIds: [],
        reviewDraft: draft,
        explanation: 'The source row needs review.',
      }),
      undefined,
      false,
      [],
    ),
    'no_price',
  )
})

test('inboxRowTitle prefers source rawText over the AI explanation', () => {
  assert.equal(
    inboxRowTitle(
      proposal({
        explanation: 'The reviewed source row is an ordinary item label.',
        sourceRowIds: ['row-1'],
      }),
      [
        {
          sourceRowId: 'row-1',
          rawText: 'A.1 | Concrete Curb NaOCL Tank',
          classification: 'item',
          page: 2,
          table: 1,
          row: 3,
        },
      ],
    ),
    'A.1 | Concrete Curb NaOCL Tank',
  )
})

test('inboxPendingCount counts only unresolved proposals', () => {
  assert.equal(
    inboxPendingCount(
      [{ id: 'a', stale: false }, { id: 'b', stale: false }, { id: 'c', stale: false }],
      { b: { status: 'skipped' }, c: 'accepted' },
    ),
    1,
  )
})

test('inboxPendingCount excludes stale proposals from unresolved count', () => {
  assert.equal(
    inboxPendingCount(
      [{ id: 'pending', stale: false }, { id: 'stale', stale: true }, { id: 'skipped', stale: false }],
      { skipped: { status: 'skipped' } },
    ),
    1,
  )
})

test('unpricedInboxGroupIds requires two or more no-price or quote-total rows', () => {
  // Rows carry their proposal and lifecycle status because a chip alone never
  // authorizes skip; these pending human-review rows are all server-skippable.
  const pending = (id: string) => proposal({ id, operation: 'needs_human_review', targetItemIds: [] })
  assert.deepEqual(
    unpricedInboxGroupIds([{ id: 'a', chip: 'no_price', proposal: pending('a'), status: undefined }]),
    [],
  )
  assert.deepEqual(
    unpricedInboxGroupIds([
      { id: 'a', chip: 'no_price', proposal: pending('a'), status: undefined },
      { id: 'b', chip: 'quote_total', proposal: pending('b'), status: undefined },
      { id: 'c', chip: 'missing_item', proposal: pending('c'), status: undefined },
    ]),
    ['a', 'b'],
  )
})

/* ------------------------------------------------------------------
 * "Not an item" eligibility: the server only skips incomplete
 * proposals, so the inbox must never offer skip for complete ones.
 * ------------------------------------------------------------------ */

const SKIP_MATRIX_OPERATIONS = [
  'needs_human_review', 'insert_missing_item', 'replace_item', 'remove_spurious_item', 'keep',
] as const

function serverSkips(candidate: ReviewableProposalFixture): boolean {
  return skipExtractionProposal({
    boq: { sections: [] } as unknown as Boq,
    proposal: candidate as unknown as ExtractionProposal,
    actorId: 'user-1',
    now: '2026-10-18T00:00:00.000Z',
    existingAudit: null,
  }).kind === 'skipped'
}

test('proposalCanBeSkipped matches the real server skip gate across operation, evidence, reconciliation, and staleness', () => {
  const refused: string[] = []
  for (const operation of SKIP_MATRIX_OPERATIONS) {
    for (const evidenceValid of [true, false]) {
      for (const reconciled of [true, false]) {
        for (const stale of [false, true]) {
          const candidate = proposal({ operation, evidenceValid, reconciled, stale })
          const label = `${operation} evidenceValid=${evidenceValid} reconciled=${reconciled} stale=${stale}`
          assert.equal(proposalCanBeSkipped(candidate), serverSkips(candidate), label)
          if (!proposalCanBeSkipped(candidate)) refused.push(label)
        }
      }
    }
  }
  assert.deepEqual(refused, [
    'insert_missing_item evidenceValid=true reconciled=true stale=false',
    'replace_item evidenceValid=true reconciled=true stale=false',
    'remove_spurious_item evidenceValid=true reconciled=true stale=false',
    'keep evidenceValid=true reconciled=true stale=false',
  ])
})

test('complete legacy keep and separate_components proposals gain no Accept, Not an item, or manual-add permission', () => {
  for (const operation of ['keep', 'separate_components'] as const) {
    const legacy = proposal({ operation, targetItemIds: ['item-1'] })
    assert.equal(proposalCanBeAccepted(legacy), false, operation)
    assert.equal(proposalCanBeSkipped(legacy), false, operation)
    assert.equal(proposalCanBeReviewedAndAdded(legacy, undefined, false), false, operation)
    assert.equal(proposalAcceptOutcomeLabel(legacy), null, operation)
  }
})

const groupSourceRows: InboxSourceRow[] = [
  { sourceRowId: 'row-total', rawText: 'Grand total', classification: 'total', page: 4, table: 1, row: 9 },
  { sourceRowId: 'row-vat', rawText: 'VAT 7%', classification: 'total', page: 4, table: 1, row: 10 },
  { sourceRowId: 'row-layer', rawText: 'Layer 2 waterproofing', classification: 'item', page: 2, table: 1, row: 4 },
  { sourceRowId: 'row-pipe', rawText: 'PVC pipe 4"', classification: 'item', page: 3, table: 1, row: 2 },
]

const completeRemoveOnTotal = proposal({
  id: 'remove-total',
  operation: 'remove_spurious_item',
  sourceRowIds: ['row-total'],
  targetItemIds: ['item-total'],
  explanation: 'The grand total row is not a BOQ item.',
})
const completeUnpricedInsert = proposal({
  id: 'insert-pipe',
  operation: 'insert_missing_item',
  sourceRowIds: ['row-pipe'],
  targetItemIds: [],
  explanation: 'The pipe row is unpriced in the deterministic BOQ.',
})
const humanReviewVat = proposal({
  id: 'human-vat',
  operation: 'needs_human_review',
  sourceRowIds: ['row-vat'],
  targetItemIds: [],
  explanation: 'VAT summary line.',
})
const humanReviewLayer = proposal({
  id: 'human-layer',
  operation: 'needs_human_review',
  sourceRowIds: ['row-layer'],
  targetItemIds: [],
  explanation: 'The row is an unpriced layer entry.',
})

function inboxGroupRow(candidate: ReviewableProposalFixture, status?: 'skipped') {
  return {
    id: candidate.id,
    chip: inboxChipForProposal(candidate, status, false, groupSourceRows),
    proposal: candidate,
    status,
  }
}

test('validated inserts are not labeled No price merely because AI prose says unpriced', () => {
  assert.equal(inboxChipForProposal(completeUnpricedInsert, undefined, false, groupSourceRows), 'needs_a_look')
})

test('complete quote-total removes and unpriced inserts never join the not-an-item group', () => {
  const rows = [completeRemoveOnTotal, humanReviewVat, completeUnpricedInsert, humanReviewLayer].map((candidate) => inboxGroupRow(candidate))
  // The validated insert is not a no-price chip, and the complete removal is
  // not server-skippable, so neither can halt grouped dismissal.
  assert.deepEqual(rows.map((row) => row.chip), ['quote_total', 'quote_total', 'needs_a_look', 'no_price'])
  assert.deepEqual(unpricedInboxGroupIds(rows), ['human-vat', 'human-layer'])
})

test('unpriced grouping needs two eligible pending rows, not two matching chips', () => {
  assert.deepEqual(unpricedInboxGroupIds([inboxGroupRow(completeRemoveOnTotal), inboxGroupRow(humanReviewVat)]), [])
  assert.deepEqual(unpricedInboxGroupIds([inboxGroupRow(completeRemoveOnTotal), inboxGroupRow(completeUnpricedInsert)]), [])
  assert.deepEqual(unpricedInboxGroupIds([inboxGroupRow(humanReviewVat, 'skipped'), inboxGroupRow(humanReviewLayer)]), [])
})

test('Accept outcome labels come only from operation and item counts, never AI prose', () => {
  const item = (id: string): ProposedExtractionItem => ({
    id,
    desc: `Proposed ${id}`,
    pricingRole: 'standard',
    sourceRowIds: ['row-1'],
    entryOrigin: 'ai_accepted',
    unit: 'm',
    qty: 1,
    rate: 10,
    total: 10,
    costComponent: 'combined',
  })
  assert.equal(proposalAcceptOutcomeLabel(proposal({ operation: 'insert_missing_item', targetItemIds: [], proposedItems: [item('a'), item('b')] })), 'Add missing item · 2 BOQ items')
  assert.equal(proposalAcceptOutcomeLabel(proposal({ operation: 'replace_item', targetItemIds: ['item-1', 'item-2'], proposedItems: [item('a')] })), 'Replace item · 2 BOQ items → 1 BOQ item')
  assert.equal(proposalAcceptOutcomeLabel(proposal({ operation: 'remove_spurious_item', targetItemIds: ['item-1', 'item-2'], proposedItems: [] })), 'Remove non-item row · 2 BOQ items')
  assert.equal(proposalAcceptOutcomeLabel(proposal({
    operation: 'remove_spurious_item',
    targetItemIds: ['item-1'],
    proposedItems: [],
    explanation: 'Insert three new priced items for this row.',
  })), 'Remove non-item row · 1 BOQ item')
  assert.equal(proposalAcceptOutcomeLabel(proposal({ operation: 'needs_human_review', targetItemIds: [] })), null)
})

test('Accept outcome counts match the BOQ items the server mutation adds and removes', () => {
  const existing = (id: string): BoqPricedItem => ({
    id, desc: `Existing ${id}`, sourceRowIds: [`row-${id}`], unit: 'm', qty: 1, rate: 10, total: 10, type: 'unit', stdStatus: 'unmatched',
  })
  const proposed = (id: string): ProposedExtractionItem => ({
    id, desc: `Proposed ${id}`, pricingRole: 'standard', sourceRowIds: ['row-1'], entryOrigin: 'ai_accepted', unit: 'm', qty: 1, rate: 10, total: 10, costComponent: 'combined',
  })
  const sections: BoqSection[] = [{ header: 'Works', items: [existing('item-1'), existing('item-2')] }]
  const targetFingerprint = { 'item-1': fingerprintCanonicalItem(sections[0].items[0]) }
  const cases = [
    {
      candidate: proposal({ operation: 'insert_missing_item', targetItemIds: [], affectedItemFingerprints: {}, proposedItems: [proposed('new-1')], destinationSectionIndex: 0, destinationItemIndex: 0 }),
      label: 'Add missing item · 1 BOQ item',
      removed: 0,
      added: 1,
    },
    {
      candidate: proposal({ operation: 'replace_item', targetItemIds: ['item-1'], affectedItemFingerprints: targetFingerprint, proposedItems: [proposed('new-1'), proposed('new-2')] }),
      label: 'Replace item · 1 BOQ item → 2 BOQ items',
      removed: 1,
      added: 2,
    },
    {
      candidate: proposal({ operation: 'remove_spurious_item', targetItemIds: ['item-1'], affectedItemFingerprints: targetFingerprint, proposedItems: [] }),
      label: 'Remove non-item row · 1 BOQ item',
      removed: 1,
      added: 0,
    },
  ]
  const beforeIds = sections.flatMap((section) => section.items).map((entry) => entry.id)
  for (const { candidate, label, removed, added } of cases) {
    assert.equal(proposalAcceptOutcomeLabel(candidate), label)
    const afterIds = applyValidatedProposal(sections, candidate as ValidatedProposal).sections
      .flatMap((section) => section.items)
      .map((entry) => entry.id)
    assert.equal(beforeIds.filter((id) => !afterIds.includes(id)).length, removed, label)
    assert.equal(afterIds.filter((id) => !beforeIds.includes(id)).length, added, label)
  }
})
