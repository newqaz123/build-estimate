import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalDecimalFromFloat,
  parseSourceQuoteSummary,
  quoteSummaryReconciliation,
} from './boq-source-quote-summary'

function validSummary() {
  return {
    directWorkTotal: '179400',
    overheadProfitAmount: '35880',
    quotedSubtotal: '215280',
    discountAmount: '1280',
    payableTotal: '214000',
    overheadProfitSourceRef: { page: 2, table: 1, row: 25 },
  }
}

function summaryOptions(overrides: Record<string, unknown> = {}) {
  return {
    directWorkTotal: '179400',
    sourceTotal: '215280',
    knownLocations: new Set(['2:1:25']),
    ...overrides,
  }
}

test('parses a closed quote summary and returns the canonical projection', () => {
  const input = validSummary()
  const parsed = parseSourceQuoteSummary(input, summaryOptions())

  assert.equal(parsed.payableTotal, '214000')
  assert.deepEqual(parsed, input)
  assert.notEqual(parsed, input)
  assert.deepEqual(parsed.overheadProfitSourceRef, { page: 2, table: 1, row: 25 })

  input.overheadProfitSourceRef!.page = 9
  assert.equal(parsed.overheadProfitSourceRef!.page, 2)
})

test('parses a minimal summary with only required amounts', () => {
  const parsed = parseSourceQuoteSummary(
    { directWorkTotal: '179400', quotedSubtotal: '179400' },
    summaryOptions({ sourceTotal: '179400' }),
  )

  assert.deepEqual(parsed, { directWorkTotal: '179400', quotedSubtotal: '179400' })
  assert.equal('overheadProfitAmount' in parsed, false)
  assert.equal('discountAmount' in parsed, false)
  assert.equal('payableTotal' in parsed, false)
})

test('rejects noncanonical decimal strings', () => {
  for (const quotedSubtotal of [
    '215280.00', '0215280', '1e3', '+215280', ' 215280', '215,280', '', '215280.', '.5',
  ]) {
    assert.throws(
      () => parseSourceQuoteSummary(
        { ...validSummary(), quotedSubtotal },
        summaryOptions(),
      ),
      /canonical nonnegative decimal/i,
      `expected rejection for ${JSON.stringify(quotedSubtotal)}`,
    )
  }
})

test('rejects negative amounts and numeric rather than string amounts', () => {
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), overheadProfitAmount: '-35880' },
      summaryOptions(),
    ),
    /canonical nonnegative decimal/i,
  )
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), directWorkTotal: 179400 },
      summaryOptions(),
    ),
    /canonical nonnegative decimal/i,
  )
})

test('rejects extra keys such as percentage', () => {
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), percentage: '20' },
      summaryOptions(),
    ),
    /percentage/i,
  )
})

test('rejects dangling and malformed source refs', () => {
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), overheadProfitSourceRef: { page: 3, table: 1, row: 25 } },
      summaryOptions(),
    ),
    /known source/i,
  )
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), overheadProfitSourceRef: { page: 2, table: 1, row: 25, column: 4 } },
      summaryOptions(),
    ),
    /unknown field/i,
  )
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), overheadProfitSourceRef: { page: 2, table: 1, row: 0 } },
      summaryOptions(),
    ),
    /row/i,
  )
})

test('rejects a direct total that does not match the checked direct items', () => {
  assert.throws(
    () => parseSourceQuoteSummary(validSummary(), summaryOptions({ directWorkTotal: '179401' })),
    /directWorkTotal/i,
  )
})

test('rejects overhead arithmetic that does not close to the quoted subtotal', () => {
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), overheadProfitAmount: '35881' },
      summaryOptions(),
    ),
    /quotedSubtotal/i,
  )
})

test('rejects discount arithmetic that does not close to the payable total', () => {
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), payableTotal: '214001' },
      summaryOptions(),
    ),
    /payableTotal/i,
  )
  assert.throws(
    () => parseSourceQuoteSummary(
      { ...validSummary(), discountAmount: '1281' },
      summaryOptions(),
    ),
    /payableTotal/i,
  )
})

test('rejects a discount or payable total without its counterpart', () => {
  const withoutPayable = validSummary()
  delete (withoutPayable as Record<string, unknown>).payableTotal
  assert.throws(
    () => parseSourceQuoteSummary(withoutPayable, summaryOptions()),
    /discount/i,
  )

  const withoutDiscount = validSummary()
  delete (withoutDiscount as Record<string, unknown>).discountAmount
  assert.throws(
    () => parseSourceQuoteSummary(withoutDiscount, summaryOptions()),
    /discount/i,
  )
})

test('accepts only sub-minor-unit legacy float differences against sourceTotal', () => {
  const parsed = parseSourceQuoteSummary(validSummary(), summaryOptions({ sourceTotal: '215280.005' }))
  assert.equal(parsed.payableTotal, '214000')

  assert.throws(
    () => parseSourceQuoteSummary(validSummary(), summaryOptions({ sourceTotal: '215280.01' })),
    /sourceTotal/i,
  )
  assert.throws(
    () => parseSourceQuoteSummary(validSummary(), summaryOptions({ sourceTotal: '215290' })),
    /sourceTotal/i,
  )
})

test('accepts a high-precision quoted subtotal rounded at the legacy float boundary', () => {
  const parsed = parseSourceQuoteSummary(
    { directWorkTotal: '9007199254740993', quotedSubtotal: '9007199254740993' },
    summaryOptions({ directWorkTotal: '9007199254740993', sourceTotal: '9007199254740992' }),
  )
  assert.equal(parsed.quotedSubtotal, '9007199254740993')
})

test('quoteSummaryReconciliation projects the quoted and payable totals', () => {
  assert.deepEqual(
    quoteSummaryReconciliation(parseSourceQuoteSummary(validSummary(), summaryOptions())),
    { quotedSubtotal: '215280', payableTotal: '214000' },
  )
  assert.deepEqual(
    quoteSummaryReconciliation(parseSourceQuoteSummary(
      { directWorkTotal: '179400', quotedSubtotal: '179400' },
      summaryOptions({ sourceTotal: '179400' }),
    )),
    { quotedSubtotal: '179400' },
  )
})

test('canonicalDecimalFromFloat expands exponent notation and rejects unsafe numbers', () => {
  assert.equal(canonicalDecimalFromFloat(215280, 'sourceTotal'), '215280')
  assert.equal(canonicalDecimalFromFloat(120.005, 'sourceTotal'), '120.005')
  assert.equal(canonicalDecimalFromFloat(1e21, 'sourceTotal'), '1000000000000000000000')
  assert.equal(canonicalDecimalFromFloat(1e-7, 'sourceTotal'), '0.0000001')
  assert.equal(canonicalDecimalFromFloat(9007199254740993, 'sourceTotal'), '9007199254740992')
  for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => canonicalDecimalFromFloat(unsafe, 'sourceTotal'), /finite/i)
  }
})
