import assert from "node:assert/strict"
import test from "node:test"

import {
  acceptAllValidatedProposalIds,
  normalizeExtractionReviewResponse,
} from "./boq-extraction-review-state"

const sourceRow = {
  sourceRowId: "row-1",
  page: 2,
  table: 1,
  row: 4,
  section: "Drainage",
  headers: ["Description", "Qty"],
  rawText: "Gutter\n62 m",
  rawCells: [{ column: 0, rawText: "Gutter", lines: ["Gutter"], columnHeader: false }],
  classification: "item",
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
