/**
 * Combines the three approval blocker dimensions (verification, catalog
 * readiness, and actionable extraction review) plus the stale-review flag into a
 * single readiness summary consumed by the approval transaction.
 *
 * `actionableBlocking` is `null` when there is no active extraction run, no
 * actionable review stage enabled, or no generated snapshot — there is nothing
 * to block on, so the actionable count is zero and the snapshot is never stale.
 */
export interface BoqApprovalReadiness {
  verificationBlocking: number
  catalogBlocking: number
  actionableReviewBlocking: number
  staleReview: boolean
}

export function buildBoqApprovalReadiness(input: {
  verificationBlocking: number
  catalogBlocking: number
  actionableBlocking: { pending: number; stale: boolean } | null
}): BoqApprovalReadiness {
  if (input.actionableBlocking === null) {
    return {
      verificationBlocking: input.verificationBlocking,
      catalogBlocking: input.catalogBlocking,
      actionableReviewBlocking: 0,
      staleReview: false,
    }
  }
  return {
    verificationBlocking: input.verificationBlocking,
    catalogBlocking: input.catalogBlocking,
    actionableReviewBlocking: input.actionableBlocking.pending,
    staleReview: input.actionableBlocking.stale,
  }
}
