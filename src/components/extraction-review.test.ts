import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const componentUrl = new URL("./extraction-review.tsx", import.meta.url)
const detailUrl = new URL("../app/(authenticated)/boqs/[id]/page.tsx", import.meta.url)

test("focused extraction review renders evidence, reconciliation, source navigation, and deliberate decisions", () => {
  assert.equal(existsSync(componentUrl), true)
  if (!existsSync(componentUrl)) return
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /Original source/)
  assert.match(source, /Proposed structure/)
  assert.match(source, /Validation & reconciliation/)
  assert.match(source, /Accept all validated high-confidence/)
  assert.match(source, />Accept\{/)
  assert.match(source, />Reject\{/)
  assert.match(source, />Undo\{/)
  assert.match(source, /Recheck with AI/)
  assert.match(source, /onNavigateToPage/)
  assert.match(source, /remainingCandidateRowIds/)
  assert.match(source, /unsafe suggestion/)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
})

test("canonical detail switches only the right pane and no longer mounts the legacy review panel", () => {
  const source = readFileSync(detailUrl, "utf8")
  assert.match(source, /type RightPaneMode = "items" \| "extraction"/)
  assert.match(source, /<ExtractionReview/)
  assert.match(readFileSync(componentUrl, "utf8"), /Back to BOQ items/)
  assert.match(source, /requestedPage=/)
  assert.match(source, /onNavigateToPage=/)
  assert.match(source, /aria-controls="boq-extraction-panel"/)
  assert.match(source, /role="tabpanel" id="boq-extraction-panel"/)
  assert.doesNotMatch(source, /import \{ ReviewPanel \}/)
  assert.doesNotMatch(source, /<ReviewPanel/)
  assert.equal((source.match(/<PdfReviewViewer/g) ?? []).length, 1)
})
