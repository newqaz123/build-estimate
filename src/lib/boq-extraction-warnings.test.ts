import assert from "node:assert/strict"
import test from "node:test"
import {
  compactExtractionWarningLocations,
  extractionWarningLabel,
  extractionWarningCount,
  extractionWarningSection,
  extractionWarningSourceLabel,
  groupExtractionWarnings,
  summarizeExtractionWarnings,
} from "./boq-extraction-warnings"
import type { BoqExtractionWarning } from "./boq-schema"

function warning(code: string, message: string, sourceRef?: BoqExtractionWarning["sourceRef"]): BoqExtractionWarning {
  return { code, message, ...(sourceRef ? { sourceRef } : {}) }
}

test("empty warnings produce no groups", () => {
  assert.deepEqual(groupExtractionWarnings([]), [])
})

test("groups warnings by code with counts and dedupes identical messages", () => {
  const warnings = [
    warning("unsupported_row", "Pricing evidence was incomplete; no numeric value was fabricated.", { page: 1, table: 1, row: 4 }),
    warning("unsupported_row", "Pricing evidence was incomplete; no numeric value was fabricated.", { page: 1, table: 1, row: 5 }),
    warning("unsupported_row", "No deterministic description evidence was found.", { page: 1, table: 1, row: 6 }),
    warning("unsupported_numeric_format", "Numeric source evidence uses an unsupported or ambiguous token format.", { page: 1, table: 1, row: 7 }),
  ]
  const groups = groupExtractionWarnings(warnings)
  assert.equal(groups.length, 2)
  // Larger group first (3 unsupported_row)
  assert.equal(groups[0].code, "unsupported_row")
  assert.equal(groups[0].count, 3)
  // Three distinct detail lines: same text at two rows are distinct locations, plus a third message
  assert.equal(groups[0].details.length, 3)
  assert.equal(groups[1].code, "unsupported_numeric_format")
  assert.equal(groups[1].count, 1)
})

test("truly identical warnings collapse in the concise view but keep every raw occurrence", () => {
  const warnings = [
    warning("unsupported_row", "Pricing evidence was incomplete.", { page: 1, table: 1, row: 4 }),
    warning("unsupported_row", "Pricing evidence was incomplete.", { page: 1, table: 1, row: 4 }),
  ]
  const groups = groupExtractionWarnings(warnings)
  // Concise default view dedupes identical message + location...
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].details.length, 1)
  // ...but technical details keep every raw occurrence individually.
  assert.equal(groups[0].occurrences.length, 2)
})

test("every raw warning occurrence is preserved individually with its exact message and location", () => {
  const warnings = [
    warning("unsupported_row", "Incomplete.", { page: 1, table: 1, row: 4 }),
    warning("unsupported_row", "Incomplete.", { page: 1, table: 1, row: 4 }),
    warning("unparsed_row", "Unreadable.", { page: 1, table: 1, row: 4 }),
  ]
  const groups = groupExtractionWarnings(warnings)
  const unsupported = groups.find((group) => group.code === "unsupported_row")!
  assert.equal(unsupported.count, 2)
  assert.equal(unsupported.occurrences.length, 2)
  const expected = { message: "Incomplete.", sourceRef: { page: 1, table: 1, row: 4 } }
  assert.deepEqual(unsupported.occurrences[0], expected)
  assert.deepEqual(unsupported.occurrences[1], expected)
  // Distinct codes keep their own occurrence lists in input order.
  const unparsed = groups.find((group) => group.code === "unparsed_row")!
  assert.equal(unparsed.occurrences.length, 1)
  assert.deepEqual(unparsed.occurrences[0], { message: "Unreadable.", sourceRef: { page: 1, table: 1, row: 4 } })
})

test("summary preserves one occurrence entry per raw warning across both sections", () => {
  const summary = summarizeExtractionWarnings([
    warning("unsupported_row", "Incomplete", { page: 2, table: 1, row: 3 }),
    warning("unsupported_row", "Incomplete", { page: 2, table: 1, row: 3 }),
    warning("source_discount", "Discount 1,280"),
    warning("source_discount", "Discount 1,280"),
    warning("document_total_mismatch", "Mismatch"),
  ])
  assert.equal(summary.rawOccurrenceCount, 5)
  assert.equal(
    [...summary.needsReview, ...summary.documentInformation].reduce(
      (total, group) => total + group.occurrences.length,
      0,
    ),
    5,
  )
})

test("group label is plain actionable copy, not the raw code", () => {
  const groups = groupExtractionWarnings([warning("unsupported_row", "msg")])
  assert.equal(groups[0].label, "Incomplete pricing or description")
})

test("unknown codes use a neutral fallback label that never echoes the internal code", () => {
  const groups = groupExtractionWarnings([warning("some_new_internal_code_xyz", "A readable message.")])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, "Other extraction note")
  assert.doesNotMatch(groups[0].label, /some_new_internal_code_xyz/)
})

test("source locations are preserved on deduplicated details", () => {
  const warnings = [
    warning("unsupported_row", "Incomplete.", { page: 2, table: 3, row: 5 }),
    warning("unsupported_row", "Incomplete.", { page: 2, table: 3, row: 8 }),
    warning("unsupported_row", "Incomplete."),
  ]
  const groups = groupExtractionWarnings(warnings)
  // Same message but different source location -> two details; plus one without location
  assert.equal(groups[0].count, 3)
  assert.equal(groups[0].details.length, 3)
  assert.equal(groups[0].details[0].sourceRef?.page, 2)
})

test("source label formats page/table/row and returns null when absent", () => {
  assert.equal(extractionWarningSourceLabel({ page: 2, table: 3, row: 5 }), "p. 2 · table 3 · row 5")
  assert.equal(extractionWarningSourceLabel(undefined), null)
})

test("extractionWarningLabel exposes plain labels for known codes", () => {
  assert.equal(extractionWarningLabel("unsupported_row"), "Incomplete pricing or description")
  assert.equal(extractionWarningLabel("item_arithmetic_mismatch"), "Quantity × rate did not match the amount")
})

test("occurrence count reflects total warnings including duplicates", () => {
  const warnings = [
    warning("unsupported_row", "a"),
    warning("unsupported_row", "a"),
    warning("unsupported_numeric_format", "b"),
  ]
  assert.equal(extractionWarningCount(warnings), 3)
})

test("detail key distinguishes identical text only when source location differs", () => {
  const sameTextDifferentLoc = [
    warning("unsupported_row", "dup", { page: 1, table: 1, row: 1 }),
    warning("unsupported_row", "dup", { page: 1, table: 1, row: 2 }),
  ]
  const groups = groupExtractionWarnings(sameTextDifferentLoc)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].details.length, 2)
})

test("summary counts unique affected review rows, document information, and raw occurrences", () => {
  const summary = summarizeExtractionWarnings([
    warning("unsupported_row", "Incomplete", { page: 2, table: 1, row: 3 }),
    warning("unparsed_row", "Unreadable", { page: 2, table: 1, row: 3 }),
    warning("unsupported_row", "Incomplete", { page: 2, table: 1, row: 7 }),
    warning("source_discount", "Discount 1,280"),
    warning("document_total_mismatch", "Mismatch"),
  ])
  assert.equal(summary.affectedRowCount, 2)
  assert.equal(summary.documentInformationCount, 1)
  assert.equal(summary.rawOccurrenceCount, 5)
  // Row 3 is flagged by two distinct codes but still counts once.
  assert.deepEqual(
    summary.needsReview.map((group) => group.code).sort(),
    ["document_total_mismatch", "unparsed_row", "unsupported_row"],
  )
  assert.deepEqual(
    summary.documentInformation.map((group) => group.code),
    ["source_discount"],
  )
})

test("summary never claims document-level information notes represent rows", () => {
  const summary = summarizeExtractionWarnings([
    warning("source_discount", "Discount 1,280"),
    warning("source_discount", "Discount 1,280"),
    warning("document_total_mismatch", "Mismatch"),
  ])
  assert.equal(summary.affectedRowCount, 0)
  assert.equal(summary.documentInformationCount, 2)
  assert.equal(summary.rawOccurrenceCount, 3)
  assert.equal(summary.needsReview.length, 1)
  assert.equal(summary.documentInformation.length, 1)
})

test("source discount is document information; review codes and unknowns are not", () => {
  assert.equal(extractionWarningSection("source_discount"), "document_information")
  assert.equal(extractionWarningSection("unsupported_row"), "needs_review")
  assert.equal(extractionWarningSection("unparsed_row"), "needs_review")
  assert.equal(extractionWarningSection("document_total_mismatch"), "needs_review")
  assert.equal(extractionWarningSection("section_total_mismatch"), "needs_review")
  // Unknown codes fail safe into needs review.
  assert.equal(extractionWarningSection("brand_new_code_q9"), "needs_review")
})

test("distinct unknown codes stay in separate stable groups inside needs review", () => {
  const summary = summarizeExtractionWarnings([
    warning("first_unknown_code", "A readable message."),
    warning("second_unknown_code", "Another readable message."),
    warning("first_unknown_code", "A readable message."),
  ])
  assert.equal(summary.documentInformation.length, 0)
  assert.equal(summary.needsReview.length, 2)
  // Larger group first, then first-seen order; identical label, distinct codes.
  assert.equal(summary.needsReview[0].code, "first_unknown_code")
  assert.equal(summary.needsReview[0].label, "Other extraction note")
  assert.equal(summary.needsReview[1].code, "second_unknown_code")
  assert.equal(summary.needsReview[1].label, "Other extraction note")
})

test("extractionWarningLabel covers emitted parser codes missing friendly labels", () => {
  assert.equal(extractionWarningLabel("invalid_numeric_format"), "Unrecognized number format")
  assert.equal(extractionWarningLabel("section_total_mismatch"), "Section total did not reconcile")
})

test("compact locations compress consecutive rows per page and table", () => {
  assert.deepEqual(
    compactExtractionWarningLocations([
      { page: 2, table: 1, row: 3 },
      { page: 2, table: 1, row: 6 },
      { page: 2, table: 1, row: 7 },
      { page: 2, table: 1, row: 8 },
      { page: 2, table: 1, row: 9 },
      { page: 2, table: 1, row: 11 },
    ]),
    { label: "Page 2 · rows 3, 6–9, 11", hiddenCount: 0 },
  )
})

test("compact locations dedupe refs, sort them, and join segments", () => {
  assert.deepEqual(
    compactExtractionWarningLocations([
      { page: 3, table: 2, row: 5 },
      { page: 2, table: 1, row: 9 },
      { page: 2, table: 1, row: 3 },
      { page: 2, table: 1, row: 3 },
      { page: 2, table: 1, row: 4 },
    ]),
    { label: "Page 2 · rows 3–4, 9; Page 3, table 2 · row 5", hiddenCount: 0 },
  )
})

test("compact locations bound the preview to whole segments and report hidden rows", () => {
  const refs = [
    { page: 1, table: 1, row: 1 },
    { page: 2, table: 1, row: 2 },
    { page: 2, table: 1, row: 3 },
    { page: 3, table: 1, row: 4 },
    { page: 3, table: 1, row: 5 },
  ]
  const bounded = compactExtractionWarningLocations(refs, 2)
  assert.deepEqual(bounded, {
    label: "Page 1 · row 1; Page 2 · rows 2–3",
    hiddenCount: 2,
  })
  // An explicit generous bound shows every segment.
  assert.equal(compactExtractionWarningLocations(refs, 10).hiddenCount, 0)
  // The default preview stays bounded so long lists stay concise.
  assert.equal(compactExtractionWarningLocations(refs).hiddenCount, 2)
  // Displayed segments never drop interior rows to fit the bound.
  assert.equal(bounded.label.includes("rows 2–3"), true)
})

test("compact locations returns an empty label for no refs", () => {
  assert.deepEqual(compactExtractionWarningLocations([]), { label: "", hiddenCount: 0 })
})
