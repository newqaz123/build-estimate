import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const styles = readFileSync(
  new URL('../../globals.css', import.meta.url),
  'utf8',
)

test('compare page is a Comparison Inbox with workspace navigation', () => {
  assert.match(source, /Comparison Inbox/)
  assert.match(source, /Open comparison/)
  assert.match(source, /Review issues/)
  assert.match(source, /boqWorkspaceHref\([^,]+,\s*"compare"/)
  assert.match(source, /boqWorkspaceHref\([^,]+,\s*"review"/)
  assert.match(source, /summarizeComponentComparison/)
  assert.match(source, /Needs review/)
  assert.match(source, /Unmatched lines/)
  assert.match(source, /Provisional material/)
  assert.match(source, /Recent BOQs/)
  assert.doesNotMatch(source, /Material rate vs catalog/)
  assert.doesNotMatch(source, /Labour rate vs catalog/)
  assert.doesNotMatch(source, /Lines with component data/)
  assert.doesNotMatch(source, /BOQ total/)
  assert.doesNotMatch(source, /BoqCatalogComponentTable/)
  assert.doesNotMatch(source, /CatalogMatchModal/)
  assert.doesNotMatch(source, /Review, match & approve/)
  assert.doesNotMatch(source, /selected\.status !== "approved"/)
})

test('compare inbox KPI strip is inbox-level, not selected-comparison cards', () => {
  assert.match(
    source,
    /className="compare-summary"[\s\S]*Needs review[\s\S]*Unmatched lines[\s\S]*Provisional material[\s\S]*Recent BOQs/,
  )
  assert.match(source, /inboxNeedsReview|needsReviewCount/)
  assert.match(source, /inboxUnmatchedLines|unmatchedLines/)
  assert.match(source, /Provisional material/)
  assert.doesNotMatch(
    source,
    /className="compare-summary"[\s\S]*Material rate vs catalog/,
  )
})

test('BOQ selection controls keep native button semantics and selected state', () => {
  assert.doesNotMatch(source, /<button\b[^>]*\brole="listitem"/)
  assert.match(source, /aria-pressed=\{isSelected\}/)
  assert.match(
    source,
    /(?:role="listitem"[\s\S]*?<button\b|<li\b[^>]*>[\s\S]*?<button\b)/,
  )
})

test('comparison workspace styles cover Direction A tabs, inbox, and panel hooks', () => {
  assert.match(styles, /\.boq-workspace-tabs\s*\{/)
  assert.match(styles, /\.compare-inbox-list\s*\{/)
  assert.match(styles, /\.boq-comparison-panel\s*\{/)
  assert.match(styles, /@media \(max-width: 920px\)/)
  assert.match(styles, /\.boq-workspace-tab:focus-visible/)
  assert.doesNotMatch(styles, /boq-workspace-progress/)
  // Actual Task 3 root hook is grouped with the planned contract selector.
  assert.match(
    styles,
    /\.boq-catalog-comparison-panel\s*,\s*\.boq-comparison-panel\s*\{|\.boq-comparison-panel\s*,\s*\.boq-catalog-comparison-panel\s*\{/,
  )
})

test('compare inbox rows use a stable four-column desktop grid', () => {
  // Markup children: project, vendor, status badge, unmatched count.
  // Reject the prior three-track desktop rule that forced the fourth child to wrap.
  assert.doesNotMatch(
    styles,
    /\.compare-inbox-(?:row|list\s*>\s*li\s*>\s*button)[^{]*\{[^}]*grid-template-columns:\s*minmax\(\s*220px\s*,\s*1fr\s*\)\s+auto\s+auto\s*;/,
  )
  assert.doesNotMatch(
    styles,
    /grid-template-columns:\s*minmax\(\s*220px\s*,\s*1fr\s*\)\s+auto\s+auto\s*;/,
  )
  // Desktop: project + vendor flexible tracks, badge + count auto tracks.
  assert.match(
    styles,
    /\.compare-inbox-row\s*,\s*\.compare-inbox-list\s*>\s*li\s*>\s*button\s*\{[^}]*grid-template-columns:\s*minmax\(\s*0\s*,\s*1\.2fr\s*\)\s+minmax\(\s*0\s*,\s*0\.9fr\s*\)\s+auto\s+auto\s*;/,
  )
})

test("compare uses workspace hrefs and resolveCompareBoqId without ReviewPanel", () => {
  assert.match(source, /useSearchParams/)
  assert.match(source, /resolveCompareBoqId/)
  assert.match(source, /boqWorkspaceHref/)
  assert.match(source, /compareBoqHref/)
  assert.match(
    source,
    /router\.push\(\s*boqWorkspaceHref\(boq\.id,\s*"review",\s*compareBoqHref\(boq\.id\)\)\s*\)/,
  )
  assert.doesNotMatch(source, /boqComparisonReviewHref/)
  assert.doesNotMatch(source, /ReviewPanel/)
  assert.doesNotMatch(source, /setReviewBoq|reviewBoq/)
})

test("compare separates BOQ-list and comparison failures", () => {
  assert.match(source, /boqLoadState/)
  assert.match(source, /comparisonLoadState/)
  assert.match(source, /Couldn&apos;t load BOQs/)
  assert.match(source, /Couldn&apos;t load this comparison/)
  assert.match(source, /onClick=\{\(\) => void loadBoqs\(preferredBoqId\)}/)
  assert.match(source, /loadComparison\(selectedId\)/)
})

test("compare cancels stale comparison work", () => {
  assert.match(source, /comparisonRequestRef/)
  assert.match(source, /new AbortController\(\)/)
  assert.match(source, /controller\.signal\.aborted/)
  assert.match(source, /comparisonRequestRef\.current !== controller/)
  assert.match(source, /comparisonRequestRef\.current\?\.abort\(\)/)
})

test("compare keeps matching ownership off the inbox", () => {
  assert.doesNotMatch(source, />AI suggest</)
  assert.doesNotMatch(source, />Dismiss</)
  assert.doesNotMatch(source, /Create and link item/)
  assert.doesNotMatch(source, /BoqCatalogComponentTable/)
  assert.doesNotMatch(source, /CatalogMatchModal/)
  assert.doesNotMatch(source, /matchTarget/)
  assert.doesNotMatch(source, /onMatch/)
})

test("inbox workspace actions remain usable on narrow screens", () => {
  assert.match(
    source,
    /data-od-id="compare-open-comparison"[^>]*className="[^"]*w-full[^"]*sm:w-auto/,
  )
  assert.match(
    source,
    /data-od-id="compare-review-issues"[^>]*className="[^"]*w-full[^"]*sm:w-auto/,
  )
  assert.match(source, /flex flex-wrap items-start justify-between/)
})
