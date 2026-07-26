import assert from "node:assert/strict"
import test from "node:test"
import {
  extractionWarningLabel,
  extractionWarningCount,
  extractionWarningSourceLabel,
  groupExtractionWarnings,
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

test("truly identical warnings (same message and location) collapse to one detail but keep the count", () => {
  const warnings = [
    warning("unsupported_row", "Pricing evidence was incomplete.", { page: 1, table: 1, row: 4 }),
    warning("unsupported_row", "Pricing evidence was incomplete.", { page: 1, table: 1, row: 4 }),
  ]
  const groups = groupExtractionWarnings(warnings)
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].details.length, 1)
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
