import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const tableSource = readFileSync(
  new URL('../../../components/boq-catalog-component-table.tsx', import.meta.url),
  'utf8',
)
const styles = readFileSync(
  new URL('../../globals.css', import.meta.url),
  'utf8',
)

/** Extract body text of each @media (max-width: Npx) block via brace matching. */
function mediaBlocks(css: string, maxWidthPx: number): string[] {
  const blocks: string[] = []
  const needle = `@media (max-width: ${maxWidthPx}px)`
  let from = 0
  while (from < css.length) {
    const at = css.indexOf('@media', from)
    if (at < 0) break
    const openParen = css.indexOf('(', at)
    const closeParen = css.indexOf(')', openParen + 1)
    if (openParen < 0 || closeParen < 0) {
      from = at + 6
      continue
    }
    const query = css
      .slice(openParen + 1, closeParen)
      .replace(/\s+/g, ' ')
      .trim()
    const normalizedHeader = `@media (${query})`
    if (normalizedHeader !== needle) {
      from = closeParen + 1
      continue
    }
    const open = css.indexOf('{', closeParen)
    if (open < 0) break
    let depth = 0
    for (let i = open; i < css.length; i += 1) {
      const ch = css[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          blocks.push(css.slice(open + 1, i))
          from = i + 1
          break
        }
      }
    }
  }
  return blocks
}

function requireMediaBlock(
  css: string,
  maxWidthPx: number,
  marker: string,
): string {
  const block = mediaBlocks(css, maxWidthPx).find((body) => body.includes(marker))
  assert.ok(
    block,
    `expected @media (max-width: ${maxWidthPx}px) block containing ${marker}`,
  )
  return block!
}

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

test('component comparison exposes mobile labels and card breakpoints', () => {
  assert.match(tableSource, /className="compare-component-group"/)
  assert.match(tableSource, /data-label="Component"/)
  assert.match(tableSource, /data-label="Quantity"/)
  assert.match(tableSource, /data-label="Catalog average"/)
  assert.match(tableSource, /data-label="Variance"/)

  // Desktop ancestors that would break mobile without scoped overrides
  assert.match(styles, /\.compare-grid\s*\{[^}]*overflow:\s*hidden/)
  assert.match(styles, /\.compare-grid\s+\.data-table\s*\{[^}]*min-width:\s*940px/)

  const mobile920 = requireMediaBlock(styles, 920, '.compare-component-group')
  assert.match(
    mobile920,
    /\.compare-grid[^{]*\{[^}]*overflow:\s*visible/,
  )
  assert.match(
    mobile920,
    /\.compare-grid\s+\.compare-component-table-wrap\s*\{[^}]*overflow:\s*visible/,
  )
  // Require the higher-specificity override (not only bare .compare-grid .compare-component-table).
  // Allows a comma-grouped rule that also lists the bare selector.
  assert.match(
    mobile920,
    /\.compare-grid\s+\.data-table\.compare-component-table(?:\s*,\s*[^{]+)?\s*\{[^}]*min-width:\s*0/,
  )
  assert.match(
    mobile920,
    /\.compare-component-table-wrap\s*\{[^}]*overflow:\s*visible/,
  )
  assert.match(
    mobile920,
    /\.compare-component-group\s*\{[^}]*display:\s*block/,
  )
  assert.match(
    mobile920,
    /\.compare-component-row\s*\{[^}]*grid-template-columns:\s*repeat\(\s*2/,
  )
  assert.match(
    mobile920,
    /\.compare-component-row\s*>\s*td::before\s*\{[^}]*content:\s*attr\(\s*data-label\s*\)/,
  )

  const mobile560 = requireMediaBlock(styles, 560, '.compare-component-row')
  assert.match(
    mobile560,
    /\.compare-component-row\s*\{[^}]*grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
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
