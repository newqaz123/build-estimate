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
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*\.compare-component-group/)
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.compare-component-row/)
})
