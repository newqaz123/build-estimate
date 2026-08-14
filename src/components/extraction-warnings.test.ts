import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const componentUrl = new URL("./extraction-warnings.tsx", import.meta.url)
const warningsLibUrl = new URL("../lib/boq-extraction-warnings.ts", import.meta.url)

test("ExtractionWarnings renders a concise unique-row task summary via summarizeExtractionWarnings", () => {
  assert.equal(existsSync(componentUrl), true)
  if (!existsSync(componentUrl)) return
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /use client/)
  assert.match(source, /summarizeExtractionWarnings/)
  assert.match(source, /extraction-warning-groups/)
  assert.match(source, /extraction-warning-group-count/)
  assert.match(source, /extraction-warning-group-label/)
  assert.match(source, /Needs review/)
  assert.match(source, /Document information/)
  assert.match(source, /source row.*need.*review/i)
  assert.match(source, /rawOccurrenceCount/)
  assert.match(source, /Technical details/)
  // The tidy summary speaks in unique affected rows and raw notes, never bare occurrences.
  assert.doesNotMatch(source, /occurrenceCount/)
  // Neutral copy that never claims items were not imported.
  assert.doesNotMatch(source, /not imported/)
})

test("ExtractionWarnings uses document-level wording when no source row is affected", () => {
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /1 document-level issue needs review/)
})

test("ExtractionWarnings shows compact locations and a bounded + N more preview", () => {
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /compactExtractionWarningLocations/)
  assert.match(source, /\+ \{hiddenCount\} more/)
})

test("ExtractionWarnings uses a single native details/summary disclosure with no duplicated toggle state", () => {
  const source = readFileSync(componentUrl, "utf8")
  // A single native <details> disclosure, no custom toggle button or useState
  assert.match(source, /<details className="extraction-warning-details">/)
  assert.match(
    source,
    /<summary className="extraction-warning-details-summary">Technical details · \{summary\.rawOccurrenceCount\} raw notes<\/summary>/,
  )
  // No custom toggle state — useState removed from the component
  assert.doesNotMatch(source, /useState/)
  assert.doesNotMatch(source, /aria-expanded=\{expanded\}/)
  assert.doesNotMatch(source, /extraction-warning-details-toggle/)
  // Exact original messages and exact source locations render inside the disclosure
  assert.match(source, /detail\.message/)
  assert.match(source, /extractionWarningSourceLabel/)
})

test("ExtractionWarnings returns null for empty warnings so it never renders an empty note", () => {
  const source = readFileSync(componentUrl, "utf8")
  assert.match(
    source,
    /if \(summary\.needsReview\.length === 0 && summary\.documentInformation\.length === 0\) return null/,
  )
})

test("grouping module never echoes raw internal codes in user-facing labels", () => {
  const libSource = readFileSync(warningsLibUrl, "utf8")
  // Unknown-code fallback is neutral, not the code itself
  assert.match(libSource, /Other extraction note/)
  assert.match(libSource, /EXTRACTION_WARNING_LABELS\[code\] \?\? UNKNOWN_CODE_LABEL/)
})
