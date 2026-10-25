import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzePreflightPages } from './boq-preflight-analysis'

test('suggests pages with Thai BOQ terms and numeric table geometry', () => {
  const result = analyzePreflightPages([
    { page: 1, embeddedText: 'Cover letter', geometry: { tableCount: 0, numericTokenCount: 0 } },
    { page: 2, embeddedText: 'รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม', geometry: { tableCount: 1, numericTokenCount: 12 } },
  ])
  assert.equal(result[0].suggested, false)
  assert.equal(result[1].suggested, true)
  assert.ok(result[1].reasons.includes('thai_boq_terms'))
})

test('recognizes English BOQ signals deterministically', () => {
  const [result] = analyzePreflightPages([
    { page: 7, embeddedText: 'Description Quantity Unit Material Labour Amount', geometry: { tableCount: 1, numericTokenCount: 8 } },
  ])
  assert.equal(result.suggested, true)
  assert.ok(result.reasons.includes('english_boq_terms'))
  assert.ok(result.reasons.includes('table_layout'))
  assert.ok(result.reasons.includes('numeric_columns'))
})

test('does not suggest a page with only description and quantity', () => {
  const [result] = analyzePreflightPages([
    { page: 3, embeddedText: 'Description Quantity 10 20 30 40 50 60', geometry: { tableCount: 1, numericTokenCount: 6 } },
  ])
  assert.equal(result.suggested, false)
  assert.ok(!result.reasons.includes('quantity_rate_amount'))
})

test('requires bounded BOQ terms instead of matching words inside other words', () => {
  const [result] = analyzePreflightPages([
    { page: 4, embeddedText: 'Descriptions quantities units amounts totals', geometry: { tableCount: 1, numericTokenCount: 12 } },
  ])
  assert.equal(result.suggested, false)
  assert.deepEqual(result.reasons, ['table_layout', 'numeric_columns'])
})

test('fails closed when no page reaches confidence threshold', () => {
  const result = analyzePreflightPages([
    { page: 1, embeddedText: 'Description', geometry: { tableCount: 0, numericTokenCount: 0 } },
    { page: 2, embeddedText: '', geometry: { tableCount: 1, numericTokenCount: 1 } },
  ])
  assert.deepEqual(result.map((page) => page.suggested), [false, false])
})

test('does not expose source text or item values in output', () => {
  const [result] = analyzePreflightPages([
    { page: 1, embeddedText: 'Description Quantity Unit 10 20', geometry: { tableCount: 1, numericTokenCount: 4 } },
  ])
  assert.deepEqual(Object.keys(result).sort(), ['confidence', 'page', 'reasons', 'suggested', 'textSource'])
  assert.equal(result.textSource, 'embedded')
})

test('suggests scanned pages that have no text layer for OCR at import', () => {
  const result = analyzePreflightPages([
    { page: 1, geometry: { tableCount: 0, numericTokenCount: 0, scanned: true } },
    { page: 2, geometry: { tableCount: 0, numericTokenCount: 0 } },
    { page: 3, embeddedText: 'Cover letter', geometry: { tableCount: 0, numericTokenCount: 0, scanned: true } },
  ])
  assert.deepEqual(result[0], { page: 1, suggested: true, confidence: 0.6, reasons: ['scanned_page'], textSource: 'unavailable' })
  assert.equal(result[1].suggested, false)
  // A page with real text is judged on its text, never as a scan.
  assert.equal(result[2].suggested, false)
  assert.ok(!result[2].reasons.includes('scanned_page'))
})
