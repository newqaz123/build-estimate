import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { DuplicateQuoteNotice } from './duplicate-quote-notice'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('duplicate notice links each look-alike quote and says why it matched', () => {
  const html = renderToStaticMarkup(
    <DuplicateQuoteNotice title="You already uploaded this PDF:" matches={[
      { id: 'b 1', project: 'Tower', vendor: 'Shop', date: '2026-10-01', status: 'approved', grandTotal: 1, reason: 'same_file' },
      { id: 'b2', project: '', vendor: '', date: '', status: 'draft', grandTotal: 1, reason: 'same_quote' },
    ]}><button type="button">Continue anyway</button></DuplicateQuoteNotice>,
  )
  assert.match(html, /href="\/boqs\/b%201"/)
  assert.match(html, /Tower · Shop · 2026-10-01/)
  assert.match(html, /approved, same PDF file/)
  assert.match(html, /Untitled quote/)
  assert.match(html, /not approved yet, same vendor, date, total and rows/)
  assert.match(html, /Continue anyway/)
  assert.equal(renderToStaticMarkup(<DuplicateQuoteNotice title="x" matches={[]} />), '')
})

test('upload asks before continuing with a PDF that was already uploaded', () => {
  const source = read('./upload-modal.tsx')
  assert.match(source, /preflight\?\.duplicates/)
  assert.match(source, /You already uploaded this PDF/)
  assert.match(source, /Open the existing quote/)
  assert.match(source, /Continue anyway/)
  assert.match(source, /setContinuedDuplicateId\(preflight\.id\)/)
})

test('review shows look-alikes and Approve asks same-or-different before counting prices twice', () => {
  const source = read('./simple-review/simple-boq-review.tsx')
  assert.match(source, /\/duplicates`/)
  assert.match(source, /body\.code === "duplicate_quote"/)
  assert.match(source, /approve\("same_quote"\)/)
  assert.match(source, /approve\("different_quote"\)/)
  assert.match(source, /duplicateDecision/)
  assert.match(source, /countedInPriceHistory === false/)
  assert.match(source, /boq\.duplicateOfBoqId/)
})
