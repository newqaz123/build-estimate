import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const componentUrl = new URL("./extraction-warnings.tsx", import.meta.url)
const warningsLibUrl = new URL("../lib/boq-extraction-warnings.ts", import.meta.url)

test("ExtractionWarnings renders a concise grouped summary instead of a flat repetitive list", () => {
  assert.equal(existsSync(componentUrl), true)
  if (!existsSync(componentUrl)) return
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /use client/)
  assert.match(source, /groupExtractionWarnings/)
  assert.match(source, /extraction-warning-groups/)
  assert.match(source, /extraction-warning-group-count/)
  assert.match(source, /extraction-warning-group-label/)
  // Neutral occurrence copy (never equates counts to rows or claims not imported)
  assert.match(source, /extraction \{occurrenceCount === 1 \? "note" : "notes"\}/)
  assert.match(source, /\{occurrenceCount === 1 \? "needs" : "need"\} review\./)
  assert.doesNotMatch(source, /not imported/)
  assert.doesNotMatch(source, /source row/)
})

test("ExtractionWarnings uses a single native details/summary disclosure with no duplicated toggle state", () => {
  const source = readFileSync(componentUrl, "utf8")
  // A single native <details> disclosure, no custom toggle button or useState
  assert.match(source, /<details className="extraction-warning-details">/)
  assert.match(source, /<summary className="extraction-warning-details-summary">Technical details<\/summary>/)
  // No custom toggle state — useState removed from the component
  assert.doesNotMatch(source, /useState/)
  assert.doesNotMatch(source, /aria-expanded=\{expanded\}/)
  assert.doesNotMatch(source, /extraction-warning-details-toggle/)
  // Exact original messages and source locations render inside the disclosure
  assert.match(source, /detail\.message/)
})

test("ExtractionWarnings preserves source locations in the grouped summary", () => {
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /extractionWarningSourceLabel/)
  assert.match(source, /extraction-warning-group-locations/)
})

test("ExtractionWarnings returns null for empty warnings so it never renders an empty note", () => {
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /if \(groups\.length === 0\) return null/)
})

test("grouping module never echoes raw internal codes in user-facing labels", () => {
  const libSource = readFileSync(warningsLibUrl, "utf8")
  // Unknown-code fallback is neutral, not the code itself
  assert.match(libSource, /Other extraction note/)
  assert.match(libSource, /EXTRACTION_WARNING_LABELS\[code\] \?\? UNKNOWN_CODE_LABEL/)
})
