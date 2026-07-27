import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreflightPageInput } from '@/lib/boq-preflight-analysis'
import { analyzePreflightPages } from '@/lib/boq-preflight-analysis'
import { mapPdfjsToPreflightInput } from '@/lib/boq-preflight-analysis-adapter'

test('mapPdfjsToPreflightInput converts pdfjs-dist output to analyzePreflightPages format', async () => {
  const pages: Array<{ pageNum: number; textItems: Array<{ str: string }> }> = [
    {
      pageNum: 1,
      textItems: [{ str: 'รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม' }],
    },
    {
      pageNum: 2,
      textItems: [{ str: 'Description Quantity Material Labour Total' }],
    },
    {
      pageNum: 3,
      textItems: [{ str: 'No text here' }],
    },
    {
      pageNum: 4,
      textItems: [],
    },
  ]

  const geometrySignal = {
    tableCount: 2,
    numericTokenCount: 10,
  }

  const result = mapPdfjsToPreflightInput(pages, geometrySignal)

  assert.deepEqual(result, [
    {
      page: 1,
      embeddedText: 'รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม',
      geometry: { tableCount: 2, numericTokenCount: 10 },
    },
    {
      page: 2,
      embeddedText: 'Description Quantity Material Labour Total',
      geometry: { tableCount: 2, numericTokenCount: 10 },
    },
    {
      page: 3,
      embeddedText: 'No text here',
      geometry: { tableCount: 2, numericTokenCount: 10 },
    },
    {
      page: 4,
      embeddedText: '',
      geometry: { tableCount: 2, numericTokenCount: 10 },
    },
  ] as PreflightPageInput[])
})

test('mapPdfjsToPreflightInput handles undefined/null text items gracefully', async () => {
  const pages: Array<{ pageNum: number; textItems: Array<{ str: string }> | undefined }> = [
    {
      pageNum: 1,
      textItems: undefined,
    },
  ]

  const geometrySignal = {
    tableCount: 0,
    numericTokenCount: 0,
  }

  const result = mapPdfjsToPreflightInput(pages, geometrySignal)

  assert.deepEqual(result, [
    {
      page: 1,
      embeddedText: '',
      geometry: { tableCount: 0, numericTokenCount: 0 },
    },
  ] as PreflightPageInput[])
})

test('mapPdfjsToPreflightInput concatenates multiple text items per page', async () => {
  const pages: Array<{ pageNum: number; textItems: Array<{ str: string }> }> = [
    {
      pageNum: 1,
      textItems: [{ str: 'รายการ' }, { str: ' ' }, { str: 'จำนวน' }],
    },
  ]

  const geometrySignal = {
    tableCount: 1,
    numericTokenCount: 5,
  }

  const result = mapPdfjsToPreflightInput(pages, geometrySignal)

  assert.equal(result[0]?.embeddedText, 'รายการ จำนวน')
})

test('analyzePreflightPages integrates with mapped pdfjs output', async () => {
  const pages: Array<{ pageNum: number; textItems: Array<{ str: string }> }> = [
    {
      pageNum: 1,
      textItems: [{ str: 'รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม' }],
    },
    {
      pageNum: 2,
      textItems: [{ str: 'Description Quantity Material Labour Total' }],
    },
    {
      pageNum: 3,
      textItems: [],
    },
  ]

  const geometrySignal = {
    tableCount: 2,
    numericTokenCount: 10,
  }

  const mapped = mapPdfjsToPreflightInput(pages, geometrySignal)
  const result = analyzePreflightPages(mapped)

  assert.equal(result.length, 3)
  assert.equal(result[0]?.page, 1)
  assert.equal(result[0]?.textSource, 'embedded')
  assert.equal(result[0]?.suggested, true)
  assert.ok(result[0]?.confidence >= 0.6)
  assert.ok(result[0]?.reasons.includes('thai_boq_terms'))

  assert.equal(result[1]?.page, 2)
  assert.equal(result[1]?.textSource, 'embedded')
  assert.equal(result[1]?.suggested, true)
  assert.ok(result[1]?.reasons.includes('english_boq_terms'))

  assert.equal(result[2]?.page, 3)
  assert.equal(result[2]?.textSource, 'unavailable')
  assert.equal(result[2]?.suggested, false)
})
