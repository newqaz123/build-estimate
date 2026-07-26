import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const workspaceUrl = new URL("./review-workspace.tsx", import.meta.url)
const stylesUrl = new URL("../app/globals.css", import.meta.url)
const detailUrl = new URL("../app/(authenticated)/boqs/[id]/page.tsx", import.meta.url)

test("review workspace exposes one PDF collapse control and an accessible resizer", () => {
  assert.equal(existsSync(workspaceUrl), true)
  if (!existsSync(workspaceUrl)) return
  const source = readFileSync(workspaceUrl, "utf8")
  assert.match(source, /role="separator"/)
  assert.match(source, /aria-valuemin=\{MIN_REVIEW_SPLIT\}/)
  assert.match(source, /aria-valuemax=\{MAX_REVIEW_SPLIT\}/)
  assert.match(source, /aria-valuenow=\{Math\.round\(split\)\}/)
  assert.match(source, /Collapse\s*<\/Button>/)
  assert.match(source, /Show PDF\s*<\/Button>/)
  assert.match(source, /Full PDF/)
  assert.match(source, /Exit full PDF/)
  assert.equal((source.match(/Collapse\s*<\/Button>/g) ?? []).length, 1)
})

test("review workspace supports pointer cancellation without invalid capture release", () => {
  assert.equal(existsSync(workspaceUrl), true)
  if (!existsSync(workspaceUrl)) return
  const source = readFileSync(workspaceUrl, "utf8")
  assert.match(source, /onPointerCancel=\{releaseResizeCapture\}/)
  assert.match(source, /onLostPointerCapture=\{stopResize\}/)
  assert.match(source, /hasPointerCapture\(event\.pointerId\)/)
  assert.match(source, /data-od-id="review-workspace-resizer"/)
})

test("review workspace keeps both panels mounted across display modes", () => {
  assert.equal(existsSync(workspaceUrl), true)
  if (!existsSync(workspaceUrl)) return
  const source = readFileSync(workspaceUrl, "utf8")
  assert.match(source, /data-od-id="review-pdf-panel"/)
  assert.match(source, /data-od-id="review-data-panel"/)
  assert.match(source, /hidden=\{mode === "pdf-collapsed"\}/)
  assert.match(source, /hidden=\{mode === "pdf-full"\}/)
  assert.doesNotMatch(source, /mode !== "pdf-collapsed"\s*&&\s*<section/)
  assert.doesNotMatch(source, /mode !== "pdf-full"\s*&&\s*<section/)
})

test("review workspace styles split, collapsed, full-PDF, and responsive modes", () => {
  const styles = readFileSync(stylesUrl, "utf8")
  assert.match(styles, /\.review-workspace-pdf-collapsed/)
  assert.match(styles, /\.review-workspace-pdf-full/)
  assert.match(styles, /\.review-show-pdf/)
  assert.match(styles, /\.review-resize-handle:focus-visible/)
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.review-workspace-pdf-full/)
})

test("review workspace makes the 12px separator visibly discoverable", () => {
  const source = readFileSync(workspaceUrl, "utf8")
  const styles = readFileSync(stylesUrl, "utf8")
  assert.match(source, /gridTemplateColumns: `minmax\(0, \$\{split\}fr\) 12px minmax\(0, \$\{100 - split\}fr\)`/)
  assert.match(styles, /\.review-resize-handle:hover/)
  assert.match(styles, /\.review-body\.is-resizing \.review-resize-handle/)
  assert.match(styles, /\.review-resize-handle:focus-visible/)
  assert.match(styles, /\.review-resize-handle span[\s\S]*height: 44px/)
})

test("missing source uses one full-width data pane without PDF display controls", () => {
  const source = readFileSync(workspaceUrl, "utf8")
  const styles = readFileSync(stylesUrl, "utf8")
  assert.match(source, /hasSource\?: boolean/)
  assert.match(source, /review-workspace-no-source/)
  assert.match(source, /hasSource \? \(/)
  assert.match(source, /!hasSource \? null/)
  assert.match(source, /Source PDF unavailable/)
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.review-workspace-no-source\s*\{\s*grid-template-rows:/)
})

test("canonical detail header keeps primary and overflow actions without a close control", () => {
  const source = readFileSync(detailUrl, "utf8")
  assert.match(source, /Back to BOQs/)
  assert.match(source, /Save draft/)
  assert.match(source, /Approve BOQ/)
  assert.match(source, /More BOQ actions/)
  assert.match(source, /Export CSV/)
  assert.match(source, /Print \/ download/)
  assert.match(source, /Delete BOQ/)
  assert.doesNotMatch(source, /Close BOQ review|<X\b/)
})

test("canonical detail data pane preserves review context and controls", () => {
  const source = readFileSync(detailUrl, "utf8")
  assert.match(source, /placeholder="Search items…"/)
  assert.match(source, /aria-label="Filter BOQ items"/)
  assert.match(source, /metadataConfidence/)
  assert.match(source, /Extraction notes/)
  assert.match(source, /Catalog readiness/)
  assert.match(source, /Grand Total:/)
  assert.doesNotMatch(source, /LLM Suggest|Accept All/)
})
