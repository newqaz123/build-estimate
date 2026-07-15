import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'

const uploadSource = readFileSync(new URL('./upload-modal.tsx', import.meta.url), 'utf8')
const detailSource = readFileSync(
  new URL('../app/(authenticated)/boqs/[id]/page.tsx', import.meta.url),
  'utf8',
)
const catalogSource = readFileSync(
  new URL('../app/(authenticated)/catalog/page.tsx', import.meta.url),
  'utf8',
)
const reviewSource = readFileSync(new URL('./review-panel.tsx', import.meta.url), 'utf8')
const standardizationSource = readFileSync(
  new URL('./standardization-review.tsx', import.meta.url),
  'utf8',
)
const boqsPageSource = readFileSync(
  new URL('../app/(authenticated)/boqs/page.tsx', import.meta.url),
  'utf8',
)

test('BOQ upload uses the atomic multipart import API and consumes its returned BOQ', () => {
  assert.doesNotMatch(uploadSource, /MOCK_PARSED_ITEMS/)
  assert.match(uploadSource, /fetch\("\/api\/boqs\/import"/)
  assert.match(uploadSource, /formData\.append\("file", file\)/)
  assert.doesNotMatch(uploadSource, /\/api\/docling\/parse/)
  assert.doesNotMatch(uploadSource, /fetch\("\/api\/boqs"/)
  assert.match(uploadSource, /const boq = await response\.json\(\) as Boq/)
  assert.match(uploadSource, /onUploadComplete\(boq\)/)
})

test('atomic BOQ import route accepts multipart input without a browser-side sidecar upload', () => {
  const routeUrl = new URL('../app/api/boqs/import/route.ts', import.meta.url)
  assert.equal(existsSync(routeUrl), true)
  const routeSource = readFileSync(routeUrl, 'utf8')
  assert.match(routeSource, /await request\.formData\(\)/)
  assert.doesNotMatch(uploadSource, /sidecarForm\.append/)
})

test('BOQ upload reads a categorized safe API error', () => {
  assert.match(uploadSource, /await readError\(response,/)
  assert.match(uploadSource, /typeof body\.error === "string"/)
})

test('review embeds the authenticated source PDF and does not manufacture source content', () => {
  assert.match(reviewSource, /`\/api\/boqs\/\$\{encodeURIComponent\(boq\.id\)\}\/source`/)
  assert.match(reviewSource, /<object[^>]+data=\{sourceUrl\}/)
  assert.match(reviewSource, /Open PDF/)
  assert.doesNotMatch(reviewSource, /pdfZoom|ZoomIn|ZoomOut/)
  assert.doesNotMatch(reviewSource, /Sino-Thai|Ratchaphruek|GRAND TOTAL|Prepared by/)
})

test('review exposes only normalized editable fields and derived approval blockers', () => {
  assert.doesNotMatch(reviewSource, />Code<|Code for item/)
  assert.doesNotMatch(reviewSource, />Type<|Type for item/)
  assert.match(reviewSource, /buildReviewVerification/)
  assert.match(reviewSource, /useMemo/)
  assert.match(reviewSource, /value="Unclassified"/)
  assert.match(reviewSource, /verification\.hasBlockingIssues/)
  assert.match(reviewSource, /key=\{reviewItemKey\(boq\.id, item, idx\)\}/)
})

test('standardization review hides legacy item codes while retaining normalized matching', () => {
  assert.doesNotMatch(standardizationSource, /\{item\.code\}/)
  assert.match(standardizationSource, /normalizeDesc\(item\.desc\)/)
  assert.match(standardizationSource, /s\.unit\.toLowerCase\(\) === itemUnit/)
})

test('BOQ list uses the shared behavior-tested CSV builder', () => {
  assert.match(boqsPageSource, /buildBoqCsv\(boq\)/)
})

test('a failed review save reports the safe error without resetting edited items', () => {
  const approveSource = reviewSource.slice(reviewSource.indexOf('const handleApprove'))
  const catchBlock = approveSource.match(/catch \(error\) \{([\s\S]*?)\} finally \{/)?.[1] ?? ''
  assert.match(catchBlock, /setSaveError\(message\)/)
  assert.doesNotMatch(catchBlock, /setItems|setVendor|setProject|setWorkType|setDate/)
})

test('BOQ detail supplies match context so an unmatched item can be added to the catalog', () => {
  assert.match(detailSource, /matchContext=\{\{/)
  assert.match(detailSource, /itemCode=\{catalogMatchTarget\.itemCode\}/)
})

test('catalog review is sourced only from approved BOQs', () => {
  assert.match(catalogSource, /if \(boq\.status !== "approved"\) continue/)
})
