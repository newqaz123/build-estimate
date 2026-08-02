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
  assert.match(
    mobile920,
    /\.compare-grid[\s\S]*?\.compare-component-table\s*\{[^}]*min-width:\s*0/,
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
