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
