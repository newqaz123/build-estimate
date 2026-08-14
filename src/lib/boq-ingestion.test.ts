import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildDraftBoq, buildDraftImport, parseDoclingResult, verifyBoqLocally } from './boq-ingestion'
import { getBoqCatalogReadiness } from './boq-catalog-readiness'
import { buildBoqCsv } from './boq-csv'
import type { Boq, BoqItem, BoqPricedItem } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'
import { v3Fixture } from './boq-extraction-test-fixtures'

function validPayload() {
  return {
    contractVersion: 2,
    documentName: 'quote.pdf',
    pageCount: 2,
    documentText: 'Quotation source text',
    tables: [{ page: 1, table: 1, rows: [['Description', 'Amount'], ['Concrete', 300]] }],
    sections: [{
      header: 'Concrete Works',
      items: [{
        id: 'sidecar-item-1',
        desc: 'Concrete',
        unit: 'm3',
        qty: 3,
        rate: 100,
        total: 300,
        type: 'unit',
        costComponent: 'combined',
        sourceRef: { page: 1, table: 1, row: 2 },
        sourceCosts: {
          material: { present: true, qty: 3, unit: 'm3', rate: 60, total: 180 },
          labour: { present: true, qty: 3, unit: 'm3', rate: 40, total: 120 },
        },
      }],
    }],
    metadata: {
      vendor: { value: 'Eastern Group', confidence: 0.95, source: 'header' },
      project: { value: 'Pump Station', confidence: 0.9, source: 'subject' },
      date: { value: '2026-06-11', confidence: 0.85, source: 'date label' },
      workType: { value: 'MEP', confidence: 0.8, source: 'keywords' },
    },
    warnings: [{ code: 'review_note', message: 'Check the source row', sourceRef: { page: 1, table: 1, row: 2 } }],
    sourceTotal: 300,
    totalItems: 1,
  }
}

function makeBoq(overrides: Partial<Boq> = {}): Boq {
  return {
    id: 'boq-1',
    project: 'Pump Station',
    vendor: 'Eastern Group',
    workType: 'MEP',
    date: '2026-06-11',
    totalItems: 1,
    grandTotal: 300,
    sourceTotal: 300,
    status: 'draft',
    stdStatus: 'none',
    sections: [{
      header: 'Concrete Works',
      items: [{
        id: 'item-1',
        code: '',
        desc: 'Concrete',
        unit: 'm3',
        qty: 3,
        rate: 100,
        total: 300,
        type: 'unit',
        stdStatus: 'unmatched',
      }],
    }],
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

function quoteSourceRow(
  id: string,
  page: number,
  table: number,
  row: number,
  rawText: string,
  classification = 'item',
) {
  return {
    id, page, table, row, section: 'Direct Works', headers: ['Description'],
    rawCells: [{
      column: 0, rawText, lines: rawText.split('\n'), rowSpan: 1, columnSpan: 1,
      startRowOffset: row - 1, endRowOffset: row,
      startColumnOffset: 0, endColumnOffset: 1,
      columnHeader: false, rowHeader: false, rowSection: false, carried: false,
    }],
    rawText, classification, confidence: 0.95, warnings: [],
  }
}

function quoteItem(id: string, rowId: string, desc: string, rate: number) {
  return {
    id, desc, pricingRole: 'standard', sourceRowIds: [rowId], parentBundleId: null,
    optional: false, excludedFromTotal: false, exclusionReason: null,
    entryOrigin: 'docling', costComponent: 'combined', sourceCosts: null,
    unit: 'item', qty: 1, rate, total: rate,
  }
}

function quoteSummaryPayload() {
  const direct = [
    ['row-q1', 'Concrete work', 25_000],
    ['row-q2', 'Formwork', 25_000],
    ['row-q3', 'Rebar', 25_000],
    ['row-q4', 'Excavation', 25_000],
    ['row-q5', 'Backfilling', 25_000],
    ['row-q6', 'Drainage', 25_000],
    ['row-q7', 'Finishing work', 29_400],
  ] as const
  return {
    contractVersion: 3,
    documentName: 'quote-summary.pdf',
    pageCount: 2,
    documentText: 'quote summary evidence',
    sourceRows: [
      ...direct.map(([rowId, desc, total]) =>
        quoteSourceRow(rowId, 1, 1, Number(rowId.slice(-1)), `${desc} | ${total}`)),
      quoteSourceRow('row-q25', 2, 1, 25, 'Overhead and profit | 35880', 'total'),
    ],
    sections: [{
      header: 'Direct Works',
      items: direct.map(([rowId, desc, total]) =>
        quoteItem(rowId.replace('row-', 'item-'), rowId, desc, total)),
    }],
    metadata: {
      vendor: { value: 'Vendor', confidence: 0.9, source: 'header' },
      project: { value: 'Project', confidence: 0.8, source: 'header' },
      date: { value: '2026-07-19', confidence: 0.7, source: 'header' },
      workType: { value: 'MEP', confidence: 0.95, source: 'keywords' },
    },
    warnings: [],
    sourceTotal: 215_280,
    sourceQuoteSummary: {
      directWorkTotal: '179400',
      overheadProfitAmount: '35880',
      quotedSubtotal: '215280',
      discountAmount: '1280',
      payableTotal: '214000',
      overheadProfitSourceRef: { page: 2, table: 1, row: 25 },
    },
    reconciliation: { itemTotal: 179_400, sourceTotal: 215_280, reconciled: true, difference: 0 },
    totalItems: 7,
  }
}

test('parseDoclingResult accepts contract version 2 and preserves source fields', () => {
  const payload = validPayload()
  const parsed = parseDoclingResult(payload)
  assert(parsed.contractVersion === 2)

  assert.notEqual(parsed, payload)
  assert.deepEqual(parsed.tables, payload.tables)
  assert.deepEqual(parsed.metadata, payload.metadata)
  assert.deepEqual(parsed.warnings, payload.warnings)
  assert.deepEqual(parsed.sections[0].items[0].sourceRef, { page: 1, table: 1, row: 2 })
  assert.deepEqual(parsed.sections[0].items[0].sourceCosts, payload.sections[0].items[0].sourceCosts)
  assert.equal(parsed.sections[0].items[0].costComponent, 'combined')
})

test('version 2 ignores source row codes so new imports cannot persist or export Code', () => {
  const payload = validPayload()
  Object.assign(payload.sections[0].items[0], { code: 'C-01' })

  const parsed = parseDoclingResult(payload)
  assert(parsed.contractVersion === 2)
  const draft = buildDraftBoq('boq-new', 'boqs/boq-new/source.pdf', parsed)
  const item = draft.sections[0].items[0] as unknown as Record<string, unknown>

  assert.equal(Object.hasOwn(parsed.sections[0].items[0], 'code'), false)
  assert.equal(Object.hasOwn(item, 'code'), false)
  assert.doesNotMatch(buildBoqCsv(draft as Boq), /Code/)
})

test('real ayt001 contract artifact cannot reintroduce source row codes', () => {
  const payload = JSON.parse(readFileSync('test-artifacts/docling-e2e/ayt001-final-docling.json', 'utf8'))
  assert.ok(payload.sections.some((section: { items: Array<{ code?: string }> }) =>
    section.items.some((item) => item.code)))

  const parsed = parseDoclingResult(payload)
  assert(parsed.contractVersion === 2)
  const draft = buildDraftBoq('boq-ayt001', 'boqs/boq-ayt001/source.pdf', parsed)

  assert.ok(parsed.sections.flatMap((section) => section.items).every((item) => !Object.hasOwn(item, 'code')))
  assert.ok(draft.sections.flatMap((section) => section.items).every((item) => !Object.hasOwn(item, 'code')))
  assert.doesNotMatch(buildBoqCsv(draft as Boq).split('\n')[0], /Code/)
})

test('parseDoclingResult rejects unsupported versions and missing metadata or provenance', () => {
  assert.throws(() => parseDoclingResult({ ...validPayload(), contractVersion: 1 }), /contractVersion/i)

  const withoutMetadata = validPayload() as Record<string, unknown>
  delete withoutMetadata.metadata
  assert.throws(() => parseDoclingResult(withoutMetadata), /metadata/i)

  const withoutSourceRef = validPayload()
  delete (withoutSourceRef.sections[0].items[0] as Partial<typeof withoutSourceRef.sections[0]['items'][0]>).sourceRef
  assert.throws(() => parseDoclingResult(withoutSourceRef), /sourceRef/i)
})

test('parseDoclingResult rejects non-finite numeric fields', () => {
  for (const number of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const itemPayload = validPayload()
    itemPayload.sections[0].items[0].qty = number
    assert.throws(() => parseDoclingResult(itemPayload), /qty/i)

    const sourceCostPayload = validPayload()
    sourceCostPayload.sections[0].items[0].sourceCosts.material.total = number
    assert.throws(() => parseDoclingResult(sourceCostPayload), /sourceCosts.*total/i)

    const sourceTotalPayload = validPayload()
    sourceTotalPayload.sourceTotal = number
    assert.throws(() => parseDoclingResult(sourceTotalPayload), /sourceTotal/i)
  }
})

test('parseDoclingResult rejects invalid confidence, work type, and cost component', () => {
  for (const confidence of [-0.1, 1.1, Number.NaN]) {
    const payload = validPayload()
    payload.metadata.vendor.confidence = confidence
    assert.throws(() => parseDoclingResult(payload), /confidence/i)
  }

  const workTypePayload = validPayload()
  workTypePayload.metadata.workType.value = 'Roofing'
  assert.throws(() => parseDoclingResult(workTypePayload), /workType/i)

  const componentPayload = validPayload()
  componentPayload.sections[0].items[0].costComponent = 'overhead'
  assert.throws(() => parseDoclingResult(componentPayload), /costComponent/i)
})

test('buildDraftBoq builds an unclassified draft from extracted values without synthetic defaults', () => {
  const payload = validPayload()
  payload.metadata.vendor.value = ''
  payload.metadata.project.value = ''
  payload.metadata.date.value = ''
  payload.metadata.workType.value = 'Unclassified'
  const parsed = parseDoclingResult(payload)
  assert(parsed.contractVersion === 2)

  const draft = buildDraftBoq('boq-22', 'boqs/boq-22/source.pdf', parsed)

  assert.equal(draft.id, 'boq-22')
  assert.equal(draft.vendor, '')
  assert.equal(draft.project, '')
  assert.equal(draft.date, '')
  assert.equal(draft.workType, 'Unclassified')
  assert.equal(draft.status, 'draft')
  assert.equal(draft.stdStatus, 'none')
  assert.equal(draft.totalItems, 1)
  assert.equal(draft.grandTotal, 300)
  assert.equal(draft.sourceFileName, 'quote.pdf')
  assert.equal(draft.sourceStoragePath, 'boqs/boq-22/source.pdf')
  assert.equal(draft.sourcePageCount, 2)
  assert.equal(draft.sourceTotal, 300)
  assert.deepEqual(draft.extractionWarnings, payload.warnings)
  assert.deepEqual(draft.metadataConfidence, { vendor: 0.95, project: 0.9, date: 0.85, workType: 0.8 })
  assert.equal(draft.sections[0].items[0].id, 'sidecar-item-1')
  assert.equal(Object.hasOwn(draft.sections[0].items[0], 'code'), false)
  assert.equal(draft.sections[0].items[0].stdStatus, 'unmatched')
  const parsedItem = draft.sections[0].items[0]
  assert.ok(isPricedBoqItem(parsedItem))
  assert.equal(parsedItem.costComponent, 'combined')
  assert.deepEqual(parsedItem.costAllocation, {
    basis: 'rate', material: 60, labour: 40, origin: 'source',
  })
  assert.deepEqual(draft.sections[0].items[0].sourceRef, { page: 1, table: 1, row: 2 })
})

test('v3 builds a canonical draft and detached immutable extraction-run seed', () => {
  const input = v3Fixture()
  const parsed = parseDoclingResult(input)
  assert(parsed.contractVersion === 3)
  const built = buildDraftImport('boq-v3', 'boqs/boq-v3/source.pdf', parsed, 'run-fixed')

  assert.ok(built.run)
  assert.equal(built.run.id, 'run-fixed')
  assert.equal(built.run.boqId, 'boq-v3')
  assert.equal(built.run.contractVersion, 3)
  assert.equal(built.run.sourceRows.length, (input.sourceRows as unknown[]).length)
  assert.deepEqual(built.run.sections, parsed.sections)
  assert.equal(built.run.documentText, 'quotation evidence')
  assert.deepEqual(built.run.reconciliation, input.reconciliation)
  assert.equal(built.boq.activeExtractionRunId, built.run.id)
  assert.equal(built.boq.totalItems, 3)
  assert.equal(built.boq.grandTotal, 95_300)

  const [parent, child, option, combined] = built.boq.sections[0].items
  assert.equal(parent.pricingRole, 'bundle_parent')
  assert.equal(child.pricingRole, 'bundle_child')
  assert.equal(child.parentBundleId, 'bundle')
  assert.equal(Object.hasOwn(child, 'qty'), false)
  assert.equal(option.optional, true)
  assert.equal(option.excludedFromTotal, true)
  assert.equal(option.entryOrigin, 'docling')
  assert.deepEqual(combined.sourceRowIds, ['row-4'])
  assert.ok(isPricedBoqItem(combined))
  assert.deepEqual(combined.sourceCosts, {
    material: { present: true, qty: 1, unit: 'set', rate: 40, total: 40 },
    labour: { present: true, qty: 1, unit: 'set', rate: 60, total: 60 },
  })

  ;(input.sourceRows as Array<Record<string, unknown>>)[0].rawText = 'caller mutation'
  assert.notEqual(built.run.sourceRows[0].rawText, 'caller mutation')
  parsed.sourceRows[0].rawText = 'parsed source mutation'
  parsed.sections[0].items[0].desc = 'parsed derivation mutation'
  built.boq.sections[0].items[0].desc = 'canonical mutation'
  assert.notEqual(built.run.sourceRows[0].rawText, 'parsed source mutation')
  assert.notEqual(built.run.sections[0].items[0].desc, 'parsed derivation mutation')
  assert.notEqual(built.run.sections[0].items[0].desc, 'canonical mutation')
  built.run.sourceRows[0].rawCells[0].lines[0] = 'run mutation'
  built.run.sections[0].items[0].desc = 'run derivation mutation'
  assert.notEqual((input.sourceRows as Array<{ rawCells: Array<{ lines: string[] }> }>)[0].rawCells[0].lines[0], 'run mutation')
  assert.notEqual(parsed.sourceRows[0].rawCells[0].lines[0], 'run mutation')
  assert.notEqual(built.boq.sections[0].items[0].desc, 'run derivation mutation')
})

test('v2 builds a legacy-compatible standard draft and no extraction run', () => {
  const built = buildDraftImport('boq-v2', 'boqs/boq-v2/source.pdf', parseDoclingResult(validPayload()), 'unused')
  assert.equal(built.run, null)
  assert.equal(built.boq.sections[0].items[0].pricingRole, 'standard')
  assert.equal(built.boq.activeExtractionRunId, undefined)
})

test('v3 zero-item extraction still builds a reviewable draft and run', () => {
  const payload = v3Fixture()
  payload.sections = []
  payload.sourceTotal = null
  payload.reconciliation = { itemTotal: 0, sourceTotal: null, reconciled: false, difference: 0 }
  payload.totalItems = 0

  const built = buildDraftImport('boq-empty', 'boqs/boq-empty/source.pdf', parseDoclingResult(payload), 'run-empty')
  assert.equal(built.boq.totalItems, 0)
  assert.equal(built.boq.grandTotal, 0)
  assert.equal(built.run?.id, 'run-empty')
})

test('v3 run IDs are caller-supplied, non-empty, and deterministic', () => {
  const parsed = parseDoclingResult(v3Fixture())
  assert.throws(() => buildDraftImport('boq-v3', 'source.pdf', parsed, ''), /runId/i)
  assert.equal(buildDraftImport('boq-v3', 'source.pdf', parsed, 'stable-id').run?.id, 'stable-id')
})

test('v3 quote summary persists on the draft BOQ and detached run seed', () => {
  const payload = quoteSummaryPayload()
  const parsed = parseDoclingResult(payload)
  assert(parsed.contractVersion === 3)
  assert.deepEqual(parsed.sourceQuoteSummary, payload.sourceQuoteSummary)

  const draft = buildDraftImport('boq-quote', 'boqs/boq-quote/source.pdf', parsed, 'run-quote')

  assert.deepEqual(draft.boq.sourceQuoteSummary, payload.sourceQuoteSummary)
  assert.deepEqual(draft.run?.sourceQuoteSummary, payload.sourceQuoteSummary)
  assert.equal(draft.boq.grandTotal, 179_400)
  assert.equal(draft.boq.sourceTotal, 215_280)
  assert.equal(draft.boq.totalItems, 7)

  ;(payload.sourceQuoteSummary as { overheadProfitAmount: string }).overheadProfitAmount = '0'
  parsed.sourceQuoteSummary!.quotedSubtotal = '0'
  draft.boq.sourceQuoteSummary!.discountAmount = '999'
  assert.notEqual(draft.boq.sourceQuoteSummary!.overheadProfitAmount, '0')
  assert.notEqual(draft.run?.sourceQuoteSummary?.discountAmount, '999')
  assert.notEqual(draft.run?.sourceQuoteSummary?.quotedSubtotal, '0')
})

test('v3 rejects a quote summary with extra keys such as percentage', () => {
  const payload = quoteSummaryPayload()
  ;(payload.sourceQuoteSummary as Record<string, unknown>).percentage = '20'
  assert.throws(() => parseDoclingResult(payload), /percentage/i)
})

test('v3 rejects numeric rather than string quote-summary amounts', () => {
  const payload = quoteSummaryPayload()
  ;(payload.sourceQuoteSummary as Record<string, unknown>).directWorkTotal = 179_400
  assert.throws(() => parseDoclingResult(payload), /canonical nonnegative decimal/i)
})

test('v3 rejects a quote summary with a dangling source ref', () => {
  const payload = quoteSummaryPayload()
  payload.sourceQuoteSummary!.overheadProfitSourceRef = { page: 9, table: 1, row: 25 }
  assert.throws(() => parseDoclingResult(payload), /known source/i)
})

test('v3 rejects quote-summary arithmetic that does not close', () => {
  const payload = quoteSummaryPayload()
  payload.sourceQuoteSummary!.overheadProfitAmount = '35881'
  assert.throws(() => parseDoclingResult(payload), /direct work plus overhead/i)
})

test('v3 rejects a quote summary that mismatches the parsed sourceTotal', () => {
  const payload = quoteSummaryPayload()
  payload.sourceTotal = 215_280.01
  payload.reconciliation = { itemTotal: 179_400, sourceTotal: 215_280.01, reconciled: false, difference: -0.01 }
  assert.throws(() => parseDoclingResult(payload), /sourceQuoteSummary\.quotedSubtotal/i)
})

test('local verification reports a line arithmetic mismatch', () => {
  const boq = makeBoq({
    grandTotal: 250,
    sourceTotal: 250,
    sections: [{
      header: 'Concrete Works',
      items: [{ code: '', desc: 'Concrete', unit: 'm3', qty: 3, rate: 100, total: 250, type: 'unit', stdStatus: 'unmatched' }],
    }],
  })

  const result = verifyBoqLocally(boq)

  assert.deepEqual(result.issues.map((issue) => issue.code), ['line_total_mismatch'])
  assert.equal(result.issues[0].severity, 'blocking')
  assert.equal(result.hasBlockingIssues, true)
})

function quoteSummaryFixture() {
  return {
    directWorkTotal: '179400',
    overheadProfitAmount: '35880',
    quotedSubtotal: '215280',
    discountAmount: '1280',
    payableTotal: '214000',
  }
}

function directWorkItem(total: number): BoqPricedItem {
  return {
    id: 'item-1',
    code: '',
    desc: 'Concrete',
    unit: 'm3',
    qty: 1,
    rate: total,
    total,
    type: 'unit',
    stdStatus: 'unmatched',
  }
}

function summaryBoq(overrides: Partial<Boq> = {}): Boq {
  return makeBoq({
    totalItems: 1,
    grandTotal: 179_400,
    sourceTotal: 215_280,
    sourceQuoteSummary: quoteSummaryFixture(),
    sections: [{ header: 'Direct Works', items: [directWorkItem(179_400)] }],
    ...overrides,
  })
}

test('local verification reports a source document total mismatch outside 0.01 tolerance', () => {
  const result = verifyBoqLocally(makeBoq({ sourceTotal: 299.98 }))

  assert.deepEqual(result.issues.map((issue) => issue.code), ['document_total_mismatch'])
  assert.equal(result.issues[0].severity, 'blocking')
})

test('summary-aware verification reconciles direct items through the quote summary', () => {
  const result = verifyBoqLocally(summaryBoq())

  assert.deepEqual(result.issues, [])
  assert.equal(result.hasBlockingIssues, false)
})

test('summary-aware verification reports a direct layer mismatch for edited direct items', () => {
  const result = verifyBoqLocally(
    summaryBoq({
      grandTotal: 179_401,
      sections: [{ header: 'Direct Works', items: [directWorkItem(179_401)] }],
    }),
  )

  assert.deepEqual(result.issues.map((issue) => issue.code), ['quote_direct_total_mismatch'])
  assert.equal(result.issues[0]?.severity, 'blocking')
  assert.equal(result.hasBlockingIssues, true)
  const mismatch = result.issues[0]
  assert.ok(mismatch)
  assert.match(mismatch.message, /direct/i)
  assert.match(mismatch.message, /179,401\.00/)
  assert.doesNotMatch(mismatch.message, /Normalized item total/)
})

test('legacy verification without a summary still reports the document total mismatch', () => {
  const legacy = summaryBoq()
  delete legacy.sourceQuoteSummary

  const result = verifyBoqLocally(legacy)

  assert.deepEqual(result.issues.map((issue) => issue.code), ['document_total_mismatch'])
})

test('suspicious zero warnings and bundle children keep their behavior beside a quote summary', () => {
  const child: BoqItem = {
    id: 'child',
    pricingRole: 'bundle_child',
    parentBundleId: 'item-1',
    desc: 'Pump body',
    stdStatus: 'pending',
  }
  const allowance: BoqPricedItem = {
    id: 'allowance',
    code: '',
    desc: 'Allowance',
    unit: 'L/S',
    qty: 0,
    rate: 0,
    total: 0,
    type: 'unit',
    stdStatus: 'unmatched',
  }

  const result = verifyBoqLocally(
    summaryBoq({
      totalItems: 3,
      sections: [{ header: 'Direct Works', items: [directWorkItem(179_400), allowance, child] }],
    }),
  )

  assert.equal(result.hasBlockingIssues, false)
  assert.ok(result.issues.some((issue) => issue.severity === 'warning' && /zero/i.test(issue.message)))
  assert.equal(result.issues.some((issue) => issue.itemId === 'child'), false)
})

test('catalog readiness counts are unchanged with or without a quote summary', () => {
  const sections: Boq['sections'] = [
    {
      header: 'Direct Works',
      items: [
        { ...directWorkItem(179_400), stdStatus: 'matched', stdId: 'std-1' },
        { ...directWorkItem(100), id: 'item-2', stdStatus: 'pending' },
        {
          id: 'child',
          pricingRole: 'bundle_child',
          parentBundleId: 'item-1',
          desc: 'Pump body',
          stdStatus: 'pending',
        } satisfies BoqItem,
      ],
    },
  ]
  const base = summaryBoq({ sections, totalItems: 2, grandTotal: 179_500 })

  const withSummary = getBoqCatalogReadiness(base)
  delete base.sourceQuoteSummary
  const withoutSummary = getBoqCatalogReadiness(base)

  assert.deepEqual(withSummary, withoutSummary)
  assert.deepEqual(withSummary, {
    total: 2,
    resolved: 1,
    blocking: 1,
    items: [
      {
        sectionIndex: 0,
        itemId: 'item-2',
        description: 'Concrete',
        reason: 'Catalog match is required',
      },
    ],
  })
})

test('local verification blocks a BOQ with no line items', () => {
  const result = verifyBoqLocally(makeBoq({ sections: [], totalItems: 0, grandTotal: 0, sourceTotal: 0 }))

  assert.deepEqual(result.issues.map((issue) => issue.code), ['items_missing'])
  assert.equal(result.issues[0].severity, 'blocking')
  assert.equal(result.hasBlockingIssues, true)
})

test('local verification reports a persisted grand total mismatch outside 0.01 tolerance', () => {
  const result = verifyBoqLocally(makeBoq({ grandTotal: 299.98 }))

  assert.deepEqual(result.issues.map((issue) => issue.code), ['grand_total_mismatch'])
  assert.equal(result.issues[0].severity, 'blocking')
  assert.equal(result.hasBlockingIssues, true)
})

test('local verification blocks missing metadata and unclassified work type', () => {
  const result = verifyBoqLocally(makeBoq({ vendor: ' ', project: '', date: '', workType: 'Unclassified' }))

  assert.equal(result.issues.length, 4)
  assert.ok(result.issues.every((issue) => issue.code === 'metadata_missing'))
  assert.ok(result.issues.every((issue) => issue.severity === 'blocking'))
  assert.equal(result.hasBlockingIssues, true)
})

test('local verification returns structured issues for malformed, non-finite, negative, and suspicious zero rows', () => {
  const malformed = { desc: null, unit: null, qty: Number.NaN, rate: -5, total: 0 }
  const suspiciousZero = { desc: 'Allowance', unit: 'L/S', qty: 0, rate: 0, total: 0 }
  const malformedSections = [{ header: 'Review', items: [malformed, suspiciousZero] }] as unknown as Boq['sections']
  const boq = makeBoq({
    grandTotal: 0,
    sourceTotal: 0,
    sections: malformedSections,
  })

  assert.doesNotThrow(() => verifyBoqLocally(boq))
  const result = verifyBoqLocally(boq)
  const numericIssues = result.issues.filter((issue) => issue.code === 'invalid_number')

  assert.ok(numericIssues.some((issue) => issue.severity === 'blocking' && /finite/i.test(issue.message)))
  assert.ok(numericIssues.some((issue) => issue.severity === 'blocking' && /negative/i.test(issue.message)))
  assert.ok(numericIssues.some((issue) => issue.severity === 'warning' && /zero/i.test(issue.message)))
  assert.equal(result.hasBlockingIssues, true)
})

test('local verification accepts a correct BOQ and arithmetic within 0.01 tolerance', () => {
  const boq = makeBoq({
    grandTotal: 300.009,
    sourceTotal: 300,
    sections: [{
      header: 'Concrete Works',
      items: [{ code: '', desc: 'Concrete', unit: 'm3', qty: 3, rate: 100, total: 300.009, type: 'unit', stdStatus: 'unmatched' }],
    }],
  })

  const result = verifyBoqLocally(boq)

  assert.deepEqual(result.issues, [])
  assert.equal(result.hasBlockingIssues, false)
})

test('local verification is not weakened by priced items carrying pricing snapshots', () => {
  const result = verifyBoqLocally(makeBoq({
    sections: [{
      header: 'Concrete Works',
      items: [{
        code: '', desc: 'Concrete', unit: 'm3', qty: 3, rate: 100, total: 300, type: 'unit', stdStatus: 'matched', stdId: 'STD-CONCRETE',
        extractedPricing: {
          description: 'Concrete', unit: 'm3', quantity: '3',
          materialRate: '60', labourRate: '40', total: '300',
        },
        reviewerPricing: {
          description: 'Concrete', unit: 'm3', quantity: '3',
          materialRate: '60', labourRate: '40', total: '300',
          confirmedAt: '2026-08-08T00:00:00.000Z', confirmedBy: 'reviewer-1',
        },
        pricingNormalization: {
          catalogId: 'STD-CONCRETE', catalogDescription: 'Concrete', catalogUnit: 'm3',
          ruleId: 'identity', catalogUnitsPerSourceUnit: '1',
          normalizedQuantity: '3', normalizedMaterialRate: '60',
          normalizedLabourRate: '40', normalizedTotal: '300',
        },
      }],
    }],
  }))

  assert.deepEqual(result.issues, [])
  assert.equal(result.hasBlockingIssues, false)
})

test('local verification skips informational children and excludes optional priced rows from totals', () => {
  const result = verifyBoqLocally({
    vendor: 'Vendor',
    project: 'Project',
    workType: 'MEP',
    date: '2026-07-19',
    grandTotal: 95_200,
    sections: [{
      header: 'Pump package',
      items: [
        { id: 'bundle', pricingRole: 'bundle_parent', desc: 'Pump package', unit: 'item', qty: 1, rate: 95_200, total: 95_200, type: 'unit', stdStatus: 'matched' },
        { id: 'child', pricingRole: 'bundle_child', parentBundleId: 'bundle', desc: 'Pump body', stdStatus: 'pending' },
        { id: 'option', desc: 'Optional controls', unit: 'item', qty: 1, rate: 10_000, total: 10_000, type: 'unit', optional: true, excludedFromTotal: true, stdStatus: 'excluded' },
      ],
    }],
  })

  assert.equal(result.hasBlockingIssues, false)
  assert.equal(result.issues.some((issue) => issue.itemId === 'child'), false)
})
