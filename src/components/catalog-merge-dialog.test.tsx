import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { priceLine } from './catalog-merge-dialog'

test('price line reads plainly for none, one and many prices', () => {
  assert.equal(priceLine(null, 'm'), 'No approved prices yet')
  assert.match(priceLine({ count: 1, min: 100, max: 100, average: 100, sources: [] }, 'm'), /^฿100\.00 \/ m from 1 approved price$/)
  assert.match(priceLine({ count: 2, min: 100, max: 200, average: 150, sources: [] }, 'm'), /from 2 approved prices \(฿100\.00–฿200\.00\)/)
  assert.ok(renderToStaticMarkup(<span>{priceLine(null, 'm')}</span>).includes('No approved prices yet'))
})

test('merge dialog previews first, merges with the chosen fields, and says nothing is deleted', () => {
  const source = readFileSync(new URL('./catalog-merge-dialog.tsx', import.meta.url), 'utf8')
  assert.match(source, /\/api\/standards\/merge\?preview=1/)
  assert.match(source, /Price history after merging/)
  assert.match(source, /archived, not deleted/)
  assert.match(source, /description: description\.trim\(\)/)
  assert.match(source, /aliases: aliases\.split/)
  assert.match(source, /disabled=\{merging \|\| !preview\}/)
})

test('catalog lets you pick items, merge them, and undo a merge', () => {
  const page = readFileSync(new URL('../app/(authenticated)/catalog/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /Merge selected \(\{selectedIds\.size\}\)/)
  assert.match(page, /<CatalogMergeDialog/)
  assert.match(page, /\/api\/standards\/merge\/undo/)
  assert.match(page, /label: "Undo"/)
  assert.match(page, /std\.lastMerge \?/)
})
