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

test('compare renders component summary and delegates grouped rows', () => {
  assert.match(source, /Material rate vs catalog/)
  assert.match(source, /Labour rate vs catalog/)
  assert.match(source, /Lines with component data/)
  assert.match(source, /BOQ total/)
  assert.match(source, /BoqCatalogComponentTable/)
  assert.match(source, /onMatch=\{setMatchTarget\}/)
  assert.match(source, /Review, match & approve/)
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

test("unapproved BOQs use canonical Details navigation instead of ReviewPanel", () => {
  assert.match(source, /useSearchParams/)
  assert.match(source, /boqComparisonReviewHref/)
  assert.match(source, /resolveCompareBoqId/)
  assert.match(source, /router\.push\(boqComparisonReviewHref\(boq\.id\)\)/)
  assert.match(source, /href=\{boqComparisonReviewHref\(selected\.id\)\}/)
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

test("compare cancels stale comparison work and suppresses false refresh success", () => {
  assert.match(source, /comparisonRequestRef/)
  assert.match(source, /new AbortController\(\)/)
  assert.match(source, /controller\.signal\.aborted/)
  assert.match(source, /comparisonRequestRef\.current !== controller/)
  assert.match(source, /if \(await loadComparison\(selected\.id\)\)/)
})

test("compare keeps matching actions on BOQ Details only", () => {
  assert.doesNotMatch(source, />AI suggest</)
  assert.doesNotMatch(source, />Dismiss</)
  assert.doesNotMatch(source, /Create and link item/)
  assert.match(source, /BoqCatalogComponentTable/)
  assert.match(source, /CatalogMatchModal/)
})

test("the preparation action remains usable on narrow screens", () => {
  assert.match(
    source,
    /data-od-id="compare-review-match"[^>]*className="[^"]*w-full[^"]*sm:w-auto/,
  )
  assert.match(source, /flex flex-wrap items-start justify-between/)
})
