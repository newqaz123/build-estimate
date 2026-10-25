import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq, BoqPricedItem } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import { buildApprovalChoices, buildQuoteNotes, buildRowFlags, importantRowKeys, issueLevel, preselectCatalog, rowKey, searchCatalog } from './simple-review'

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
    { code: 'rate_outlier', category: 'misread', severity: 'warning', message: 'Rate looks 10x higher than similar rows', itemId: 'c' },
    { code: 'line_total_mismatch', severity: 'warning', message: 'dup', itemId: 'a' },
    { code: 'quantity_outlier', category: 'number_error', severity: 'warning', message: 'by position', sectionIndex: 0, itemIndex: 1 },
  ])
  assert.match(flags.get(rowKey(0, 0))![0]!.text, /Qty × rate = 20, but total says 25/)
  assert.equal(flags.get(rowKey(0, 0))!.length, 1, 'AI duplicate of the math check is dropped')
  const b = flags.get(rowKey(0, 1))!.map((f) => f.text)
  assert.ok(b.some((t) => t.startsWith('Text read by OCR')))
  assert.ok(b.includes('Quantity is 0'))
  assert.ok(b.includes('AI: by position'))
  assert.deepEqual(flags.get(rowKey(0, 2)), [{ kind: 'ai', text: 'AI: Rate looks 10x higher than similar rows', level: 'important' }])
})

test('buildRowFlags: AI advisory findings become collapsed notes; only important rows are counted', () => {
  const flags = buildRowFlags(quote([
    item('a', 'Pipe', 'm', 2, 10),
    item('b', 'Valve', 'ea', 1, 10),
    item('c', 'Paint', 'm2', 1, 5),
    item('d', 'Paint', 'm2', 1, 5),
  ]), [
    { code: 'description_unclear', category: 'advisory', severity: 'warning', message: 'Short text', itemId: 'a' },
    { code: 'possible_duplicate', category: 'number_error', severity: 'warning', message: 'Same as row d', itemId: 'c' },
    { code: 'unit_mismatch', category: 'advisory', severity: 'warning', message: 'Unit may be odd', itemId: 'b' },
    { code: 'rate_outlier', category: 'misread', severity: 'warning', message: 'Rate shifted', itemId: 'd' },
  ])
  assert.equal(flags.get('0:0')![0]!.level, 'note')
  assert.equal(flags.get('0:1')![0]!.level, 'note', 'advisory category stays a note even on a numeric code')
  assert.equal(flags.get('0:2')![0]!.level, 'note', 'wording codes stay notes even if the AI calls them errors')
  assert.equal(flags.get('0:3')![0]!.level, 'important')
  assert.deepEqual([...importantRowKeys(flags)], ['0:3'])
})

test('issueLevel: rule findings without a category stay important unless wording-only', () => {
  assert.equal(issueLevel({ code: 'invalid_number' }), 'important')
  assert.equal(issueLevel({ code: 'metadata_missing' }), 'note')
  assert.equal(issueLevel({ code: 'rate_outlier', category: 'advisory' }), 'note')
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

test('preselectCatalog leaves a weak guess unselected but remembers the closest item', () => {
  const standards = [standard('s-pipe', 'Take off existing pipe', 'lot'), standard('s-roof', 'Take off existing roof SS400', 'lot'),
    standard('s-2b', 'Steel pipe 2B', 'm'), standard('s-4b', 'Steel pipe 4B', 'm')]
  const picks = preselectCatalog(quote([
    item('a', 'Take off existing gutter', 'lot', 1, 1),
    item('b', 'Take off existingroof', 'lot', 1, 1),
    item('c', 'Steel pipe', 'm', 1, 1),
  ]), standards, {})
  assert.deepEqual(picks.get('0:0'), { standardId: null, reason: 'Unsure', suggestedId: 's-pipe' })
  assert.equal(picks.get('0:1')!.standardId, 's-roof')
  assert.equal(picks.get('0:2')!.standardId, null, 'two sizes equally close: do not guess')
  assert.equal(picks.get('0:2')!.reason, 'Unsure')
})
