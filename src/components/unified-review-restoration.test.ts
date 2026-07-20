import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const workspaceUrl = new URL("./review-workspace.tsx", import.meta.url)
const viewerUrl = new URL("./pdf-review-viewer.tsx", import.meta.url)
const detailUrl = new URL("../app/(authenticated)/boqs/[id]/page.tsx", import.meta.url)
const listUrl = new URL("../app/(authenticated)/boqs/page.tsx", import.meta.url)

test("upload opens the unified BOQ detail and matching workspace", () => {
  const listSource = readFileSync(listUrl, "utf8")
  const detailSource = readFileSync(detailUrl, "utf8")

  assert.match(listSource, /router\.push\(boqDetailHref\(boq\.id\)\)/)
  assert.doesNotMatch(listSource, /<ReviewPanel/)
  assert.match(detailSource, /<ReviewWorkspace/)
  assert.match(detailSource, /<UnifiedBoqItemsTable/)
  assert.match(detailSource, /<PdfReviewViewer/)
  assert.match(detailSource, /Extraction review/)
  assert.match(detailSource, /<ExtractionReview/)
  assert.doesNotMatch(detailSource, /<ReviewPanel/)
})

test("the unified workspace restores resizable and collapsible PDF controls", () => {
  assert.equal(existsSync(workspaceUrl), true)
  assert.equal(existsSync(viewerUrl), true)
  if (!existsSync(workspaceUrl)) return

  const workspaceSource = readFileSync(workspaceUrl, "utf8")
  assert.match(workspaceSource, /role="separator"/)
  assert.match(workspaceSource, /Collapse\s*<\/Button>/)
  assert.match(workspaceSource, /Show PDF\s*<\/Button>/)
  assert.match(workspaceSource, /Full PDF/)
  assert.match(workspaceSource, /data-od-id="review-workspace-resizer"/)
})

test("catalog acceptance participates in the page-level mutation lock", () => {
  const detailSource = readFileSync(detailUrl, "utf8")

  assert.match(detailSource, /const handleAcceptCatalogSuggestion = async/)
  assert.match(detailSource, /if \(isReadOnly \|\| mutationBusy\) return\s+setMatching\(true\)/)
  assert.match(detailSource, /await catalogMatching\.acceptSuggestion\(row\)/)
  assert.match(detailSource, /finally \{\s+setMatching\(false\)\s+\}/)
  assert.match(detailSource, /onAcceptSuggestion=\{\(row\) => \{ void handleAcceptCatalogSuggestion\(row\) \}\}/)
})
