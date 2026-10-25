import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq, BoqPricedItem } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import { buildApprovalChoices, buildQuoteNotes, buildRowFlags, preselectCatalog, rowKey, searchCatalog } from './simple-review'

const NOW = '2026-10-25T12:00:00.000Z'
function item(id: string, desc: string, unit: string, qty: number, rate: number, extra: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return { id, desc, unit, qty, rate, total: qty * rate, type: 'unit', stdStatus: 'unmatched', ...extra }
}
function standard(id: string, description: string, unit: string, extra: Partial<StandardEntry> = {}): StandardEntry {
  return { id, description, unit, aliases: [], sourceItems: [], sourceBoqCount: 0, createdAt: NOW, updatedAt: NOW, ...extra }
}
function quote(items: BoqPricedItem[]): Pick<Boq, 'sections'> {
  return { sections: [{ header: 'Works', items }] }
}

test('buildRowFlags: clean rows get no flags', () => {
  assert.equal(buildRowFlags(quote([item('a', 'Pipe', 'm', 2, 10)])).size, 0)
})

test('buildRowFlags: math, zero values, parser warnings and AI issues become short reasons', () => {
  const flags = buildRowFlags(quote([
    item('a', 'Pipe', 'm', 2, 10, { total: 25 }),
    item('b', 'Valve', 'ea', 0, 10, { extractionWarnings: [{ code: 'ocr_corrected', message: 'Quantity read as 1O, fixed to 10' }] }),
    item('c', 'Paint', 'm2', 1, 5),
  ]), [
    { code: 'suspicious_rate', severity: 'warning', message: 'Rate looks 10x higher than similar rows', itemId: 'c' },
    { code: 'line_total_mismatch', severity: 'warning', message: 'dup', itemId: 'a' },
    { code: 'suspicious_rate', severity: 'warning', message: 'by position', sectionIndex: 0, itemIndex: 1 },
  ])
  assert.match(flags.get(rowKey(0, 0))![0]!.text, /Qty × rate = 20, but total says 25/)
  assert.equal(flags.get(rowKey(0, 0))!.length, 1, 'AI duplicate of the math check is dropped')
  const b = flags.get(rowKey(0, 1))!.map((f) => f.text)
  assert.ok(b.some((t) => t.startsWith('Text read by OCR')))
  assert.ok(b.includes('Quantity is 0'))
  assert.ok(b.includes('AI: by position'))
  assert.deepEqual(flags.get(rowKey(0, 2)), [{ kind: 'ai', text: 'AI: Rate looks 10x higher than similar rows' }])
})

test('buildQuoteNotes keeps only issues not pinned to a row', () => {
  const notes = buildQuoteNotes([
    { code: 'document_total_mismatch', severity: 'warning', message: 'x' },
    { code: 'suspicious_rate', severity: 'warning', message: 'pinned', itemId: 'a' },
    { code: 'metadata_missing', severity: 'blocking', message: 'Work type missing' },
    { code: 'missing_scope', severity: 'warning', message: 'No scaffolding listed' },
  ], new Set(['0:0']), new Set(['a']))
  assert.deepEqual(notes, ['Sum of rows does not match the total printed on the PDF.', 'No scaffolding listed'])
})

test('preselectCatalog keeps saved links, picks the best match, and falls back to none', () => {
  const standards = [standard('s-pipe', 'Steel pipe 2 inch', 'm'), standard('s-old', 'Old', 'm', { archivedAt: NOW }), standard('s-paint', 'Paint', 'm2')]
  const picks = preselectCatalog(quote([
    item('a', 'Steel pipe 2 inch', 'm', 1, 1),
    item('b', 'Something unrelated', 'ea', 1, 1),
    item('c', 'Anything', 'm', 1, 1, { stdStatus: 'matched', stdId: 's-paint', stdConfidence: 'manual' }),
    item('d', 'Anything', 'm', 1, 1, { stdStatus: 'excluded' }),
    item('e', 'Anything', 'm', 1, 1, { stdStatus: 'matched', stdId: 's-old' }),
  ]), standards, {})
  assert.deepEqual(picks.get('0:0'), { standardId: 's-pipe', confidence: 'exact', reason: 'Exact' })
  assert.deepEqual(picks.get('0:1'), { standardId: null, reason: 'None found' })
  assert.deepEqual(picks.get('0:2'), { standardId: 's-paint', confidence: 'manual', reason: 'Saved' })
  assert.deepEqual(picks.get('0:3'), { standardId: null, reason: 'Saved' })
  assert.equal(picks.get('0:4')!.standardId, null, 'archived link is not kept')
})

test('preselectCatalog does not pick a unit-incompatible item', () => {
  const picks = preselectCatalog(quote([item('a', 'Paint', 'ea', 1, 1)]), [standard('s-paint', 'Paint', 'm2')], {})
  assert.equal(picks.get('0:0')!.standardId, null)
})

test('searchCatalog finds by substring and by row text', () => {
  const standards = [standard('s1', 'Steel pipe 2 inch', 'm'), standard('s2', 'Gate valve 2 inch', 'ea'), standard('s3', 'Archived valve', 'ea', { archivedAt: NOW })]
  assert.deepEqual(searchCatalog('valve', { desc: 'x', unit: 'm' }, standards, {}).map((s) => s.id), ['s2'])
  assert.equal(searchCatalog('', { desc: 'Steel pipe 2 inch', unit: 'm' }, standards, {})[0]!.id, 's1')
})

test('buildApprovalChoices sends every priced row with its pick', () => {
  const q = quote([item('a', 'Pipe', 'm', 1, 1), item('b', 'Paint', 'm2', 1, 1)])
  const picks = new Map([['0:0', { standardId: 's1', confidence: 'fuzzy' as const, reason: 'Similar' }]])
  assert.deepEqual(buildApprovalChoices(q, picks), [
    { sectionIndex: 0, itemIndex: 0, itemId: 'a', standardId: 's1', confidence: 'fuzzy' },
    { sectionIndex: 0, itemIndex: 1, itemId: 'b', standardId: null },
  ])
})
