import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBoqApprovalReadiness } from './boq-approval-readiness'

test('pending actionable suggestions block approval with the pending count', () => {
  const readiness = buildBoqApprovalReadiness({
    verificationBlocking: 0,
    catalogBlocking: 0,
    actionableBlocking: { pending: 2, stale: false },
  })

  assert.equal(readiness.actionableReviewBlocking, 2)
  assert.equal(readiness.staleReview, false)
  assert.equal(readiness.verificationBlocking, 0)
  assert.equal(readiness.catalogBlocking, 0)
})

test('a stale actionable snapshot blocks approval even with no pending suggestions', () => {
  const readiness = buildBoqApprovalReadiness({
    verificationBlocking: 0,
    catalogBlocking: 0,
    actionableBlocking: { pending: 0, stale: true },
  })

  assert.equal(readiness.staleReview, true)
  assert.equal(readiness.actionableReviewBlocking, 0)
})

test('unresolved verification and catalog blockers are surfaced unchanged alongside the review state', () => {
  const readiness = buildBoqApprovalReadiness({
    verificationBlocking: 1,
    catalogBlocking: 3,
    actionableBlocking: { pending: 1, stale: true },
  })

  assert.equal(readiness.verificationBlocking, 1)
  assert.equal(readiness.catalogBlocking, 3)
  assert.equal(readiness.actionableReviewBlocking, 1)
  assert.equal(readiness.staleReview, true)
})

test('a fully resolved draft passes with no blockers and a fresh review', () => {
  const readiness = buildBoqApprovalReadiness({
    verificationBlocking: 0,
    catalogBlocking: 0,
    actionableBlocking: { pending: 0, stale: false },
  })

  assert.equal(readiness.verificationBlocking, 0)
  assert.equal(readiness.catalogBlocking, 0)
  assert.equal(readiness.actionableReviewBlocking, 0)
  assert.equal(readiness.staleReview, false)
})

test('an approved read-only BOQ with no review activity passes', () => {
  const readiness = buildBoqApprovalReadiness({
    verificationBlocking: 0,
    catalogBlocking: 0,
    actionableBlocking: { pending: 0, stale: false },
  })

  assert.equal(readiness.actionableReviewBlocking, 0)
  assert.equal(readiness.staleReview, false)
})

test('no active extraction run or generated snapshot produces no actionable blocker', () => {
  const readiness = buildBoqApprovalReadiness({
    verificationBlocking: 0,
    catalogBlocking: 0,
    actionableBlocking: null,
  })

  assert.equal(readiness.actionableReviewBlocking, 0)
  assert.equal(readiness.staleReview, false)
})

test('a stale flag is never carried when there is nothing to block on', () => {
  const readiness = buildBoqApprovalReadiness({
    verificationBlocking: 0,
    catalogBlocking: 0,
    actionableBlocking: null,
  })

  assert.equal(readiness.staleReview, false)
})
