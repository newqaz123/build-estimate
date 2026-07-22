import assert from "node:assert/strict"
import test from "node:test"

import {
  acceptAllValidatedProposalIds,
  beginReviewSnapshotRequest,
  extractionReviewReducer,
  filterReviewProposals,
  filterReviewSourceRows,
  initialExtractionReviewState,
  normalizeExtractionReviewResponse,
  extractionReviewRefreshAction,
  invalidateReviewSnapshotRequests,
  isLatestReviewSnapshotRequest,
  selectReviewVisibility,
} from "./boq-extraction-review-state"
import type { ExtractionReviewResponse } from "./boq-extraction-ai-review"
import type { ProposalOperation, ValidatedProposal } from "./boq-extraction-proposals"

const sourceRow = {
  sourceRowId: "row-1",
  page: 2,
  table: 1,
  row: 4,
  section: "Drainage",
  headers: ["Description", "Qty"],
  rawText: "Gutter\n62 m",
  rawCells: [],
  classification: "item" as const,
  confidence: 0.82,
  warnings: [{ code: "compound", message: "Multiple entries" }],
}

test("normalizes AI, fallback, and not-required review responses without trusting malformed shapes", () => {
  const base = {
    aiStatus: "completed",
    message: "Ready",
    sourceRowIds: ["row-1"],
    remainingCandidateRowIds: [],
    sourceRefs: [{ sourceRowId: "row-1", page: 2, table: 1, row: 4 }],
    sourceRows: [sourceRow],
    proposals: [],
    rejectedProposals: [],
  }

  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "ai" })?.mode, "ai")
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "fallback", aiStatus: "timeout" })?.aiStatus, "timeout")
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "not_required", aiStatus: "not_required" })?.mode, "not_required")
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "ai", sourceRows: [{ ...sourceRow, rawText: 123 }] }), null)
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "surprise" }), null)
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "ai", proposalStatuses: { p1: { status: "accepted", canUndo: "yes" } } }), null)
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "ai", snapshotMode: "merge" }), null)
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "ai", reviewRun: { status: "running", reviewTargeting: { candidateRowIds: "row-1", unreconciled: false } } }), null)
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "ai", reviewRun: { status: "running", reviewTargeting: { candidateRowIds: ["row-1"], ambiguousRowIds: "row-1", unreconciledRowIds: [], unreconciled: false } } }), null)
  assert.equal(normalizeExtractionReviewResponse({ ...base, mode: "ai", proposalStatuses: { p1: { status: "pending", canUndo: false, stale: "no", eligible: true } } }), null)
})

test("bulk acceptance selects only validated, evidenced, reconciled, high-confidence, non-stale proposals", () => {
  const safe = { id: "safe", operation: "split", confidence: 0.9, evidenceValid: true, reconciled: true, stale: false }
  assert.deepEqual(acceptAllValidatedProposalIds([
    safe,
    { ...safe, id: "low", confidence: 0.89 },
    { ...safe, id: "stale", stale: true },
    { ...safe, id: "human", operation: "needs_human_review" },
    { ...safe, id: "rejected", evidenceValid: false },
  ], { safe: undefined, low: undefined, stale: undefined, human: undefined, rejected: undefined }), ["safe"])
  assert.deepEqual(acceptAllValidatedProposalIds([safe], { safe: "accepted" }), [])
})

function proposal(id: string, sourceRowId: string, operation: ProposalOperation = "split"): ValidatedProposal {
  return {
    id, extractionRunId: "run-1", operation, sourceRowIds: [sourceRowId], targetItemIds: [], affectedItemFingerprints: {},
    confidence: 0.95, explanation: id, proposedItems: [], evidenceValid: true, reconciled: true, stale: false,
  }
}

function response(proposals: ValidatedProposal[], sourceRows: ExtractionReviewResponse["sourceRows"] = [sourceRow]): ExtractionReviewResponse {
  return {
    mode: "ai" as const, aiStatus: "completed" as const, message: "Ready",
    sourceRowIds: sourceRows.map((row) => row.sourceRowId), remainingCandidateRowIds: [],
    sourceRefs: sourceRows.map((row) => ({ sourceRowId: row.sourceRowId, page: row.page, table: row.table, row: row.row })),
    sourceRows, proposals, rejectedProposals: [],
  }
}

test("row recheck replaces only that source row and preserves unrelated proposal lifecycle", () => {
  let state = extractionReviewReducer(initialExtractionReviewState(), { type: "review_succeeded", response: response([
    proposal("row-1-old", "row-1"), proposal("row-2", "row-2"),
  ], [sourceRow, { ...sourceRow, sourceRowId: "row-2", row: 5 }]) })
  state = extractionReviewReducer(state, { type: "proposal_status", proposalId: "row-2", status: "accepted" })
  state = extractionReviewReducer(state, { type: "toggle_expanded", proposalId: "row-2" })
  state = extractionReviewReducer(state, { type: "review_succeeded", sourceRowId: "row-1", response: response([proposal("row-1-new", "row-1")]) })

  assert.deepEqual(state.review?.proposals.map((entry) => entry.id), ["row-2", "row-1-new"])
  assert.equal(state.proposalStatuses["row-2"], "accepted")
  assert.equal(state.expandedProposalIds["row-2"], false)
})

test("durable full-snapshot row recheck replaces active proposals without duplicating stored unrelated rows", () => {
  const initial = extractionReviewReducer(initialExtractionReviewState(), { type: "review_succeeded", response: response([
    proposal("old-row-1", "row-1"), proposal("row-2", "row-2"),
  ], [sourceRow, { ...sourceRow, sourceRowId: "row-2", row: 5 }]) })
  const storedPostSnapshot = {
    ...response([proposal("new-row-1", "row-1"), proposal("row-2", "row-2")], [sourceRow, { ...sourceRow, sourceRowId: "row-2", row: 5 }]),
    snapshotMode: "replace" as const,
    proposalStatuses: {
      "new-row-1": { status: "pending" as const, canUndo: false, stale: false, eligible: true },
      "row-2": { status: "pending" as const, canUndo: false, stale: false, eligible: true },
    },
  }
  const state = extractionReviewReducer(initial, { type: "review_succeeded", sourceRowId: "row-1", response: storedPostSnapshot })
  assert.deepEqual(state.review?.proposals.map((entry) => entry.id), ["new-row-1", "row-2"])
  assert.equal(new Set(state.review?.proposals.map((entry) => entry.id)).size, 2)
  assert.equal(state.review?.sourceRows.length, 2)
  assert.equal(state.proposalStatuses["old-row-1"], undefined)
  assert.deepEqual(Object.keys(state.proposalCanUndo).sort(), ["new-row-1", "row-2"])
})

test("review filters expose pending, accepted, rejected, and needs-attention proposals", () => {
  const proposals = [proposal("pending", "row-1"), proposal("accepted", "row-2"), proposal("rejected", "row-3"), proposal("human", "row-4", "needs_human_review")]
  const statuses = { accepted: "accepted", rejected: "rejected" } as const
  assert.deepEqual(filterReviewProposals(proposals, statuses, "pending").map((entry) => entry.id), ["pending"])
  assert.deepEqual(filterReviewProposals(proposals, statuses, "accepted").map((entry) => entry.id), ["accepted"])
  assert.deepEqual(filterReviewProposals(proposals, statuses, "rejected").map((entry) => entry.id), ["rejected"])
  assert.deepEqual(filterReviewProposals(proposals, statuses, "needs-attention").map((entry) => entry.id), ["human"])
})

test("source-row filters keep compound candidates, ambiguous evidence, reconciliation failures, and AI pending distinct", () => {
  const compound = { ...sourceRow, sourceRowId: "row-compound", classification: "continuation" as const, confidence: 0.98, warnings: [] }
  const ambiguous = { ...sourceRow, sourceRowId: "row-ambiguous", confidence: 0.72, warnings: [] }
  const unreconciled = { ...sourceRow, sourceRowId: "row-unreconciled", confidence: 0.98, warnings: [{ code: "section_total_mismatch", message: "Section total mismatch" }] }
  const unrelated = { ...sourceRow, sourceRowId: "row-unrelated", confidence: 0.98, warnings: [] }
  const review = {
    ...response([proposal("p1", "row-ambiguous")], [compound, ambiguous, unreconciled, unrelated]),
    remainingCandidateRowIds: ["row-compound", "row-unreconciled"],
    reviewRun: { status: "partial" as const, reviewTargeting: {
      candidateRowIds: ["row-compound", "row-ambiguous", "row-unreconciled"],
      ambiguousRowIds: ["row-ambiguous"], unreconciledRowIds: ["row-unreconciled"], unreconciled: true,
    } },
  }
  assert.deepEqual(filterReviewSourceRows(review, "ambiguous").map((row) => row.sourceRowId), ["row-ambiguous"])
  assert.deepEqual(filterReviewSourceRows(review, "unreconciled").map((row) => row.sourceRowId), ["row-unreconciled"])
  assert.deepEqual(filterReviewSourceRows(review, "ai-pending").map((row) => row.sourceRowId), ["row-compound", "row-unreconciled"])
})

test("review visibility applies status and source filters without leaking the unfiltered source list", () => {
  const ambiguous = { ...sourceRow, sourceRowId: "row-ambiguous", confidence: 0.72, warnings: [] }
  const pending = { ...sourceRow, sourceRowId: "row-pending", confidence: 0.98, warnings: [] }
  const acceptedProposal = proposal("accepted", "row-ambiguous")
  const review = {
    ...response([acceptedProposal], [ambiguous, pending]),
    remainingCandidateRowIds: ["row-pending"],
    reviewRun: { status: "partial" as const, reviewTargeting: {
      candidateRowIds: ["row-ambiguous", "row-pending"], ambiguousRowIds: ["row-ambiguous"], unreconciledRowIds: [], unreconciled: false,
    } },
  }

  const accepted = selectReviewVisibility(review, { accepted: "accepted" }, "accepted")
  assert.deepEqual(accepted.proposals.map((entry) => entry.id), ["accepted"])
  assert.deepEqual(accepted.sourceRows, [])

  const aiPending = selectReviewVisibility(review, { accepted: "accepted" }, "ai-pending")
  assert.deepEqual(aiPending.proposals, [])
  assert.deepEqual(aiPending.sourceRows.map((row) => row.sourceRowId), ["row-pending"])
})

test("selectReviewVisibility displayed-result totals back the per-filter chip counts", () => {
  const ambiguous = { ...sourceRow, sourceRowId: "row-ambiguous", confidence: 0.72, warnings: [] }
  const pending = { ...sourceRow, sourceRowId: "row-pending", confidence: 0.98, warnings: [] }
  const acceptedProposal = proposal("accepted", "row-ambiguous")
  const review = {
    ...response([acceptedProposal], [ambiguous, pending]),
    remainingCandidateRowIds: ["row-pending"],
    reviewRun: { status: "partial" as const, reviewTargeting: {
      candidateRowIds: ["row-ambiguous", "row-pending"], ambiguousRowIds: ["row-ambiguous"], unreconciledRowIds: [], unreconciled: false,
    } },
  }
  const statuses = { accepted: "accepted" } as const
  const count = (filter: "all" | "accepted" | "pending" | "rejected" | "needs-attention" | "ambiguous" | "unreconciled" | "ai-pending") => {
    const result = selectReviewVisibility(review, statuses, filter)
    return result.proposals.length + result.sourceRows.length
  }
  assert.equal(count("all"), 1)
  assert.equal(count("accepted"), 1)
  assert.equal(count("pending"), 0)
  assert.equal(count("rejected"), 0)
  assert.equal(count("needs-attention"), 0)
  assert.equal(count("ambiguous"), 1)
  assert.equal(count("unreconciled"), 0)
  assert.equal(count("ai-pending"), 1)
})

test("review refresh selector dispatches queued and expired leases but only polls a live running lease", () => {
  const base = response([]) as ExtractionReviewResponse & { reviewRun: NonNullable<ExtractionReviewResponse["reviewRun"]> }
  base.reviewRun = { status: "queued", reviewTargeting: { candidateRowIds: ["row-1"], unreconciled: false } }
  const now = Date.parse("2026-07-20T12:00:00.000Z")
  assert.equal(extractionReviewRefreshAction(base, false, now), "dispatch")
  assert.equal(extractionReviewRefreshAction({ ...base, reviewRun: { ...base.reviewRun, status: "running", leaseExpiresAt: "2026-07-20T12:00:01.000Z" } }, false, now), "poll")
  assert.equal(extractionReviewRefreshAction({ ...base, reviewRun: { ...base.reviewRun, status: "running", leaseExpiresAt: "2026-07-20T12:00:01.000Z" } }, true, now), "poll")
  assert.equal(extractionReviewRefreshAction({ ...base, reviewRun: { ...base.reviewRun, status: "running", leaseExpiresAt: "2026-07-20T12:00:00.000Z" } }, false, now), "dispatch")
  assert.equal(extractionReviewRefreshAction({ ...base, reviewRun: { ...base.reviewRun, status: "running", leaseExpiresAt: "invalid" } }, false, now), "dispatch")
  assert.equal(extractionReviewRefreshAction({ ...base, reviewRun: { ...base.reviewRun, status: "running" } }, false, now), "dispatch")
  assert.equal(extractionReviewRefreshAction({ ...base, reviewRun: { ...base.reviewRun, status: "failed" } }, false, now), "idle")
  assert.equal(extractionReviewRefreshAction(base, true, now), "idle")
})

test("request and proposal mutation state preserve loaded review evidence", () => {
  const loaded = extractionReviewReducer(initialExtractionReviewState(), { type: "review_succeeded", response: response([proposal("p1", "row-1")]) })
  const requesting = extractionReviewReducer(loaded, { type: "review_started", sourceRowId: "row-1" })
  const mutating = extractionReviewReducer(requesting, { type: "proposal_action_started", proposalId: "p1", action: "accepting" })
  assert.equal(mutating.review?.proposals[0]?.id, "p1")
  assert.equal(mutating.loading, true)
  assert.equal(mutating.proposalActions.p1, "accepting")
})

test("optimistic accepted state never exposes Undo before durable LIFO eligibility reloads", () => {
  const loaded = extractionReviewReducer(initialExtractionReviewState(), { type: "review_succeeded", response: response([proposal("p1", "row-1")]) })
  const accepted = extractionReviewReducer(loaded, { type: "proposal_status", proposalId: "p1", status: "accepted", canUndo: false })
  assert.equal(accepted.proposalStatuses.p1, "accepted")
  assert.equal(accepted.proposalCanUndo.p1, false)
})

test("durable review snapshots are latest-request-wins across reverse resolution and invalidation", async () => {
  const generation = { current: 0 }
  let visible = "initial"
  let resolveOlder!: (value: string) => void
  let resolveNewer!: (value: string) => void
  const older = new Promise<string>((resolve) => { resolveOlder = resolve })
  const newer = new Promise<string>((resolve) => { resolveNewer = resolve })
  const olderRequest = beginReviewSnapshotRequest(generation)
  const olderCommit = older.then((value) => {
    if (isLatestReviewSnapshotRequest(generation, olderRequest)) visible = value
  })
  const newerRequest = beginReviewSnapshotRequest(generation)
  const newerCommit = newer.then((value) => {
    if (isLatestReviewSnapshotRequest(generation, newerRequest)) visible = value
  })

  resolveNewer("newest stale and undo state")
  await newerCommit
  resolveOlder("obsolete state")
  await olderCommit
  assert.equal(visible, "newest stale and undo state")

  const invalidatedRequest = beginReviewSnapshotRequest(generation)
  invalidateReviewSnapshotRequests(generation)
  assert.equal(isLatestReviewSnapshotRequest(generation, invalidatedRequest), false)
})
