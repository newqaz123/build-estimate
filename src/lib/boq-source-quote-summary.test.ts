import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalDecimalFromFloat,
  parseSourceQuoteSummary,
  quoteSummaryReconciliation,
  verifySourceQuoteSummary,
  type BoqSourceQuoteSummary,
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

test('verifySourceQuoteSummary accepts the reconciled closed summary', () => {
  assert.deepEqual(
    verifySourceQuoteSummary({
      directItemTotal: '179400',
      sourceTotal: '215280',
      summary: validSummary(),
    }),
    [],
  )
})

test('verifySourceQuoteSummary reports a direct layer mismatch with exact amounts', () => {
  const issues = verifySourceQuoteSummary({
    directItemTotal: '179401',
    sourceTotal: '215280',
    summary: validSummary(),
  })

  assert.deepEqual(issues.map((issue) => issue.code), ['quote_direct_total_mismatch'])
  assert.match(issues[0]!.message, /direct/i)
  assert.match(issues[0]!.message, /179,401\.00/)
  assert.match(issues[0]!.message, /179,400\.00/)
  assert.doesNotMatch(issues[0]!.message, /Normalized item total/)
})

test('verifySourceQuoteSummary reports tampered overhead closing as a subtotal mismatch', () => {
  const issues = verifySourceQuoteSummary({
    directItemTotal: '179400',
    sourceTotal: '215280',
    summary: { ...validSummary(), overheadProfitAmount: '35881' },
  })

  assert.deepEqual(issues.map((issue) => issue.code), ['quote_subtotal_mismatch'])
  assert.match(issues[0]!.message, /subtotal/i)
  assert.match(issues[0]!.message, /215,280\.00/)
  assert.match(issues[0]!.message, /35,881\.00/)
  assert.doesNotMatch(issues[0]!.message, /Normalized item total/)
})

test('verifySourceQuoteSummary reports tampered discount arithmetic as a payable mismatch', () => {
  for (const [tampered, expectedAmount] of [
    [{ ...validSummary(), payableTotal: '214001' }, /214,001\.00/],
    [{ ...validSummary(), discountAmount: '1281' }, /1,281\.00/],
  ] as const) {
    const issues = verifySourceQuoteSummary({
      directItemTotal: '179400',
      sourceTotal: '215280',
      summary: tampered,
    })

    assert.deepEqual(issues.map((issue) => issue.code), ['quote_payable_total_mismatch'])
    assert.match(issues[0]!.message, /payable/i)
    assert.match(issues[0]!.message, expectedAmount)
    assert.match(issues[0]!.message, /215,280\.00/)
    assert.doesNotMatch(issues[0]!.message, /Normalized item total/)
  }
})

test('verifySourceQuoteSummary anchors the quoted subtotal to the source total at the float boundary', () => {
  assert.deepEqual(
    verifySourceQuoteSummary({
      directItemTotal: '179400',
      sourceTotal: '215280.005',
      summary: validSummary(),
    }),
    [],
  )

  const issues = verifySourceQuoteSummary({
    directItemTotal: '179400',
    sourceTotal: '215280.01',
    summary: validSummary(),
  })
  assert.deepEqual(issues.map((issue) => issue.code), ['quote_subtotal_mismatch'])
  assert.match(issues[0]!.message, /215,280\.01/)
  assert.match(issues[0]!.message, /215,280\.00/)
})

test('verifySourceQuoteSummary requires exact direct-item reconciliation', () => {
  const issues = verifySourceQuoteSummary({
    directItemTotal: '179400.005',
    sourceTotal: '215280',
    summary: validSummary(),
  })

  assert.deepEqual(issues.map((issue) => issue.code), ['quote_direct_total_mismatch'])
  assert.match(issues[0]!.message, /BOQ direct items total/)
  assert.match(issues[0]!.message, /179,400\.01/)
  assert.match(issues[0]!.message, /source quote direct work total/)
  assert.match(issues[0]!.message, /179,400\.00/)
})

test('verifySourceQuoteSummary reconciles a minimal summary without optional layers', () => {
  assert.deepEqual(
    verifySourceQuoteSummary({
      directItemTotal: '179400',
      sourceTotal: '179400',
      summary: { directWorkTotal: '179400', quotedSubtotal: '179400' },
    }),
    [],
  )
})

test('verifySourceQuoteSummary returns no issues without a summary', () => {
  assert.deepEqual(verifySourceQuoteSummary({ directItemTotal: '179400', sourceTotal: '215280' }), [])
})

test('verifySourceQuoteSummary flags malformed summary layers without throwing', () => {
  const malformed = verifySourceQuoteSummary({
    directItemTotal: '179400',
    sourceTotal: '215280',
    summary: {
      quotedSubtotal: '215280',
      overheadProfitAmount: 'not-a-number',
    } as unknown as BoqSourceQuoteSummary,
  })

  assert.deepEqual(malformed.map((issue) => issue.code).sort(), [
    'quote_direct_total_mismatch',
    'quote_subtotal_mismatch',
  ])
})

test('verifySourceQuoteSummary flags a discount without its payable counterpart', () => {
  const withoutPayable = validSummary()
  delete (withoutPayable as Record<string, unknown>).payableTotal
  const issues = verifySourceQuoteSummary({
    directItemTotal: '179400',
    sourceTotal: '215280',
    summary: withoutPayable,
  })

  assert.deepEqual(issues.map((issue) => issue.code), ['quote_payable_total_mismatch'])
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
