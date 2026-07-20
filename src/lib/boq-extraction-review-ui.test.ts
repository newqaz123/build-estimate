import assert from 'node:assert/strict'
import test from 'node:test'
import {
  proposalCanBeAccepted,
  proposalIsHighConfidence,
  sourceReferenceLabel,
} from './boq-extraction-review-ui'
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
    operation: 'separate_components',
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
  assert.equal(proposalCanBeAccepted(proposal({ stale: true })), false)
})

test('source references remain compact and auditable in the review panel', () => {
  assert.equal(sourceReferenceLabel({ sourceRowId: 'row-17', page: 2, table: 3, row: 5 }), 'p. 2 · table 3 · row 5')
})
