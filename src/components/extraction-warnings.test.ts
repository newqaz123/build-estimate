import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { ExtractionWarnings } from "./extraction-warnings"

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
    /<summary className="extraction-warning-details-summary">\s*Technical details · \{summary\.rawOccurrenceCount\} raw notes\s*<\/summary>/,
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
    /if \(\s*summary\.needsReview\.length === 0 &&\s*summary\.documentInformation\.length === 0\s*\)\s*return null/,
  )
})

test("grouping module never echoes raw internal codes in user-facing labels", () => {
  const libSource = readFileSync(warningsLibUrl, "utf8")
  // Unknown-code fallback is neutral, not the code itself
  assert.match(libSource, /Other extraction note/)
  assert.match(libSource, /EXTRACTION_WARNING_LABELS\[code\] \?\? UNKNOWN_CODE_LABEL/)
})

function technicalDetailEntries(html: string): number {
  return (html.match(/class="extraction-warning-detail"/g) ?? []).length
}

test("Technical details renders one entry per raw warning occurrence, including identical duplicates", () => {
  const warnings = [
    { code: "unsupported_row", message: "Incomplete.", sourceRef: { page: 2, table: 1, row: 3 } },
    { code: "unsupported_row", message: "Incomplete.", sourceRef: { page: 2, table: 1, row: 3 } },
  ]
  const html = renderToStaticMarkup(createElement(ExtractionWarnings, { warnings }))
  assert.match(html, /2 raw notes/)
  // Entry count must equal rawOccurrenceCount: duplicates are not collapsed.
  assert.equal(technicalDetailEntries(html), 2)
  // Every occurrence keeps its exact code, message, and exact location.
  assert.equal((html.match(/Incomplete\./g) ?? []).length, 2)
  assert.equal((html.match(/p\. 2 · table 1 · row 3/g) ?? []).length, 2)
})

test("Technical details entry count equals rawOccurrenceCount across mixed warnings", () => {
  const warnings = [
    { code: "unsupported_row", message: "A", sourceRef: { page: 2, table: 1, row: 3 } },
    { code: "unsupported_row", message: "A", sourceRef: { page: 2, table: 1, row: 3 } },
    { code: "source_discount", message: "Discount 1,280" },
    { code: "source_discount", message: "Discount 1,280" },
    { code: "document_total_mismatch", message: "Mismatch" },
  ]
  const html = renderToStaticMarkup(createElement(ExtractionWarnings, { warnings }))
  assert.match(html, /5 raw notes/)
  assert.equal(technicalDetailEntries(html), 5)
  // Concise headline view is unchanged: one unique affected row.
  assert.match(html, /1 source row needs review\./)
})

test("duplicate document-level review failures render plural wording driven by raw occurrences", () => {
  const warnings = [
    { code: "document_total_mismatch", message: "Mismatch" },
    { code: "document_total_mismatch", message: "Mismatch" },
  ]
  const html = renderToStaticMarkup(createElement(ExtractionWarnings, { warnings }))
  assert.match(html, /2 document-level issues need review\./)
  assert.doesNotMatch(html, /1 document-level issue needs review/)
})
