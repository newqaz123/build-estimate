import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildDraftBoq, parseDoclingResult, verifyBoqLocally } from './boq-ingestion'
import { buildBoqCsv } from './boq-csv'
import type { Boq } from './boq-schema'

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

test('parseDoclingResult accepts contract version 2 and preserves source fields', () => {
  const payload = validPayload()
  const parsed = parseDoclingResult(payload)

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
  assert.equal(draft.sections[0].items[0].costComponent, 'combined')
  assert.deepEqual(draft.sections[0].items[0].costAllocation, {
    basis: 'rate', material: 60, labour: 40, origin: 'source',
  })
  assert.deepEqual(draft.sections[0].items[0].sourceRef, { page: 1, table: 1, row: 2 })
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

test('local verification reports a source document total mismatch outside 0.01 tolerance', () => {
  const result = verifyBoqLocally(makeBoq({ sourceTotal: 299.98 }))

  assert.deepEqual(result.issues.map((issue) => issue.code), ['document_total_mismatch'])
  assert.equal(result.issues[0].severity, 'blocking')
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
