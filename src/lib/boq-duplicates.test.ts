import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from './boq-schema'
import { countableApprovedQuotes, findDuplicateQuotes, findSameFile, normalizeVendorName, quotesLookSame } from './boq-duplicates'

const NOW = '2026-10-25T00:00:00.000Z'

function quote(id: string, overrides: Partial<Boq> = {}, totals = [100, 200, 300, 400]): Boq {
  return {
    id, project: 'P', vendor: 'ACME Co., Ltd.', workType: 'MEP', date: '2026-10-01', totalItems: totals.length,
    grandTotal: totals.reduce((sum, total) => sum + total, 0), status: 'draft', stdStatus: 'none', createdAt: NOW, updatedAt: NOW,
    sections: [{ header: 'S', items: totals.map((total, index) => ({ id: `i${index}`, desc: `Item ${index}`, unit: 'm', qty: 1, rate: total, total, type: 'unit' as const, stdStatus: 'unmatched' as const })) }],
    ...overrides,
  }
}

test('vendor names compare without company words, spaces or punctuation', () => {
  assert.equal(normalizeVendorName('ACME Co., Ltd.'), normalizeVendorName('acme'))
  assert.equal(normalizeVendorName('บริษัท เอ บี ซี จำกัด'), normalizeVendorName('เอบีซี'))
})

test('a re-scan with the same vendor, date, total and lines looks like the same quote', () => {
  const rescan = quote('b', { vendor: 'ACME' })
  rescan.sections[0]!.items[0]!.desc = 'Itern 0 (OCR)'
  assert.equal(quotesLookSame(quote('a'), rescan), true)
  assert.equal(quotesLookSame(quote('a'), quote('b', { date: '2026-10-02' })), false)
  assert.equal(quotesLookSame(quote('a'), quote('b', { vendor: 'Other Shop' })), false)
  assert.equal(quotesLookSame(quote('a'), quote('b', {}, [100, 200, 300, 401])), false)
  // Same total but different lines is a different quote.
  assert.equal(quotesLookSame(quote('a'), quote('b', {}, [250, 250, 250, 250])), false)
  // Vendor and date both unknown: never guess.
  assert.equal(quotesLookSame(quote('a', { vendor: '', date: '' }), quote('b', { vendor: '', date: '' })), false)
})

test('same-file matches come first and never include the quote itself', () => {
  const target = quote('t', { sourceDigest: 'sha256:x' })
  const matches = findDuplicateQuotes(target, [target, quote('scan', { vendor: 'ACME' }), quote('file', { sourceDigest: 'sha256:x', grandTotal: 1 })])
  assert.deepEqual(matches.map((m) => [m.id, m.reason]), [['file', 'same_file'], ['scan', 'same_quote']])
  assert.deepEqual(findSameFile('sha256:x', [target, quote('n')]).map((m) => m.id), ['t'])
  assert.deepEqual(findSameFile('', [target]), [])
})

test('price history counts a repeated quote once unless the user said it is different', () => {
  const first = quote('first', { status: 'approved', approvedAt: '2026-10-02T00:00:00Z', sourceDigest: 'sha256:x' })
  const sameFile = quote('again', { status: 'approved', approvedAt: '2026-10-03T00:00:00Z', sourceDigest: 'sha256:x', vendor: 'Other' })
  const identical = quote('copy', { status: 'approved', approvedAt: '2026-10-04T00:00:00Z' })
  const marked = quote('marked', { status: 'approved', approvedAt: '2026-10-05T00:00:00Z', duplicateOfBoqId: 'first', vendor: 'Z' })
  const draft = quote('draft')
  assert.deepEqual(countableApprovedQuotes([marked, identical, sameFile, first, draft]).map((q) => q.id), ['first'])

  const confirmed = { ...identical, confirmedDistinctFrom: ['first'] }
  assert.deepEqual(countableApprovedQuotes([first, confirmed]).map((q) => q.id), ['first', 'copy'])
})
