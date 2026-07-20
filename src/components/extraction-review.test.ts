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
  assert.match(source, /Add missing item/)
  assert.match(source, /\/items`,\s*\{[\s\S]{0,120}?method: "POST"/)
  assert.doesNotMatch(source, /import \{ ReviewPanel \}/)
  assert.doesNotMatch(source, /<ReviewPanel/)
  assert.equal((source.match(/<PdfReviewViewer/g) ?? []).length, 1)
})

test("compare review reuses the standalone extraction review instead of a duplicate controller", () => {
  const source = readFileSync(new URL("./review-panel.tsx", import.meta.url), "utf8")
  assert.match(source, /<ExtractionReview/)
  assert.equal((source.match(/runExtractionReview/g) ?? []).length, 0)
})

test("approved review receives a read-only contract", () => {
  const source = readFileSync(detailUrl, "utf8")
  assert.match(source, /readOnly=\{isReadOnly\}/)
  assert.match(readFileSync(componentUrl, "utf8"), /readOnly/)
})

test("unsaved detail and compare edits block structural extraction mutations until Save draft", () => {
  const componentSource = readFileSync(componentUrl, "utf8")
  const detailSource = readFileSync(detailUrl, "utf8")
  const compareSource = readFileSync(new URL("./review-panel.tsx", import.meta.url), "utf8")
  assert.match(componentSource, /mutationBlockedReason\?: string/)
  assert.match(componentSource, /mutationBlockedReason && \(action === "accept" \|\| action === "undo"\)/)
  assert.match(componentSource, /Save draft before applying or undoing extraction corrections/)
  assert.match(componentSource, /disabled=\{readOnly \|\| Boolean\(mutationBlockedReason\)/)
  assert.match(detailSource, /mutationBlockedReason=\{pendingChanges > 0 \? /)
  assert.match(compareSource, /const reviewDirty = reviewFingerprint !== savedReviewFingerprint/)
  assert.match(compareSource, /mutationBlockedReason=\{reviewDirty \? /)
  assert.match(compareSource, /Save draft<\/Button>/)
  assert.match(compareSource, /status: "draft"/)
})

test("accepted and undone actions reload durable LIFO Undo eligibility", () => {
  const source = readFileSync(componentUrl, "utf8")
  assert.match(source, /const refreshStoredReview = useCallback/)
  assert.match(source, /action === "accept" \|\| action === "undo"[\s\S]*?await refreshStoredReview\(\)/)
  assert.match(source, /proposal_status", proposalId, status: "accepted", canUndo: false/)
  assert.doesNotMatch(source, /bulkProposalIds\.forEach\(\(proposalId\) => dispatch\(\{ type: "proposal_status", proposalId, status: "accepted" \}\)\)/)
})

test("a saved canonical revision reloads durable staleness without dispatching another provider review", () => {
  const componentSource = readFileSync(componentUrl, "utf8")
  const detailSource = readFileSync(detailUrl, "utf8")
  const compareSource = readFileSync(new URL("./review-panel.tsx", import.meta.url), "utf8")
  assert.match(componentSource, /canonicalRevisionKey: string/)
  assert.match(componentSource, /canonicalRevisionRef\.current !== canonicalRevisionKey/)
  assert.match(componentSource, /canonicalRevisionRef\.current = canonicalRevisionKey[\s\S]*?void refreshStoredReview\(\)/)
  assert.match(componentSource, /Canonical BOQ changed\. Recheck with AI/)
  assert.match(detailSource, /const canonicalRevisionKey = useMemo\(\(\) => buildCanonicalRevisionKey\(boq\), \[boq\]\)/)
  assert.match(detailSource, /canonicalRevisionKey=\{canonicalRevisionKey\}/)
  assert.match(compareSource, /const \[canonicalRevisionKey, setCanonicalRevisionKey\] = useState\(\(\) => buildCanonicalRevisionKey\(boq\)\)/)
  assert.match(compareSource, /setCanonicalRevisionKey\(buildCanonicalRevisionKey\(updated\)\)/)
  assert.match(compareSource, /canonicalRevisionKey=\{canonicalRevisionKey\}/)
})

test("compare approval cannot start while a draft or item mutation is in flight", () => {
  const source = readFileSync(new URL("./review-panel.tsx", import.meta.url), "utf8")
  assert.match(source, /const handleApprove = async \(\) => \{\s*if \(busy \|\| verification\.hasBlockingIssues\) return/)
  assert.match(source, /onClick=\{handleApprove\} disabled=\{busy \|\| verification\.hasBlockingIssues/)
})

test("responsive review follows the 920px and 520px Open Design breakpoints", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
  assert.match(css, /@media \(max-width: 920px\)[\s\S]*?\.review-body[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/)
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.extraction-proposal-footer/)
})
