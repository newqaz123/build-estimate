import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./review-panel.tsx', import.meta.url), 'utf8')
const extractionSource = readFileSync(new URL('./extraction-review.tsx', import.meta.url), 'utf8')

test('the review panel keeps compound evidence and accepted suggestions visibly auditable', () => {
  assert.match(source, /<ExtractionReview/)
  assert.match(source, /<PdfReviewViewer/)
  assert.match(source, /requestedPage=\{pdfPageRequest\.page\}/)
  assert.match(source, /onNavigateToPage=\{\(page\) => setPdfPageRequest/)
  assert.match(extractionSource, /data-od-id="focused-extraction-review"/)
  assert.match(extractionSource, /Current BOQ structure/)
  assert.match(extractionSource, /Informational child · no second total/)
  assert.match(extractionSource, /sourceReferenceLabel\(source\)/)
  assert.match(source, /item\.optional \? <span[^>]*>\{item\.excludedFromTotal === true \? "Optional · excluded from total" : "Optional"\}/)
})

test('the review panel requires deliberate accept/reject actions and supports safe bulk accept and undo', () => {
  assert.match(extractionSource, /Accept all validated high-confidence/)
  assert.match(extractionSource, /proposalCanBeAccepted/)
  assert.match(extractionSource, /\/proposals\/accept-batch/)
  assert.match(extractionSource, /executeAction\(proposal, "accept"\)/)
  assert.match(extractionSource, /executeAction\(proposal, "reject"\)/)
  assert.match(extractionSource, /executeAction\(proposal, "undo"\)/)
  assert.match(extractionSource, /Recheck with AI/)
})

test('the review panel offers a user-entered missing-item path without manufacturing a source price', () => {
  assert.match(source, /Add missing item/)
  assert.match(source, /\/items`, \{[\s\S]{0,100}method: "POST"/)
  assert.doesNotMatch(source, /setItems\(\(current\) => \[\.\.\.current, \{/)
  assert.match(source, /current\.some\(\(item\) => item\.id === added\.id\)[\s\S]*?\[\.\.\.current, added\]/)
  assert.match(source, /New items are user-entered and remain unpriced until you add a rate\./)
})

test('compare review can include an excluded optional row through the canonical audited endpoint', () => {
  assert.match(source, /handleIncludeOptional/)
  assert.match(source, /excludedFromTotal: false/)
  assert.match(source, /method: "PATCH"/)
  assert.match(source, /Include in total/)
  assert.match(source, /current\.map\(\(candidate, index\) => index === itemIndex/)
})

test('compare review rows use the same labelled two-column and single-column mobile card handoff', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  assert.match(source, /data-label="Description"/)
  assert.match(source, /data-label="Material"/)
  assert.match(css, /@media \(max-width: 920px\)[\s\S]*?\.review-items-table tbody tr[^{]*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.review-items-table tbody tr[^{]*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/)
})
