import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseDoclingResult, type DoclingResultV3 } from './boq-extraction-schema'
import { v3Fixture } from './boq-extraction-test-fixtures'

function clone<T>(value: T): T {
  return structuredClone(value)
}

test('accepts a real v3 bundle, option, and combined component shape', () => {
  const parsed = parseDoclingResult(v3Fixture())
  assert.equal(parsed.contractVersion, 3)
  assert.equal(parsed.sections[0].items[1].pricingRole, 'bundle_child')
  assert.equal(parsed.totalItems, 3)
})

test('accepts the checked-in Python-produced HTTP response shape', () => {
  const payload = JSON.parse(readFileSync('test-fixtures/docling/contract-v3-http-shape.json', 'utf8'))
  const parsed = parseDoclingResult(payload)
  assert.equal(parsed.contractVersion, 3)
  assert.equal(parsed.sections[0].items[0].total, 0.09)
})

test('accepts a zero-item v3 response as reviewable evidence', () => {
  const payload = v3Fixture()
  payload.sections = []
  payload.sourceTotal = null
  payload.reconciliation = { itemTotal: 0, sourceTotal: null, reconciled: false, difference: 0 }
  payload.totalItems = 0
  const parsed = parseDoclingResult(payload)
  assert.equal(parsed.contractVersion, 3)
  assert.equal(parsed.totalItems, 0)
})

test('normalizes nested nulls omitted by the sidecar HTTP response', () => {
  const payload = v3Fixture()
  const row = (payload.sourceRows as Array<Record<string, unknown>>)[0]
  delete row.section
  payload.sections = []
  delete payload.sourceTotal
  payload.reconciliation = { itemTotal: 0, reconciled: false, difference: 0 }
  payload.totalItems = 0

  const parsed = parseDoclingResult(payload)
  assert(parsed.contractVersion === 3)
  assert.equal(parsed.sourceRows[0].section, null)
  assert.equal(parsed.reconciliation.sourceTotal, null)
})

test('accepts a sparse trailing logical row with no cells as retained unknown evidence', () => {
  const payload = v3Fixture()
  ;(payload.sourceRows as Array<Record<string, unknown>>).push({
    id: 'row-empty', page: 1, table: 1, row: 5, section: 'Pump Works',
    headers: ['Description'], rawCells: [], rawText: '', classification: 'unknown',
    confidence: 1, warnings: [],
  })

  const parsed = parseDoclingResult(payload)
  assert(parsed.contractVersion === 3)
  assert.deepEqual(parsed.sourceRows.at(-1)?.rawCells, [])
})

test('rejects missing raw-cell evidence, nonempty rows without cells, and inconsistent geometry', () => {
  const absent = v3Fixture()
  delete (absent.sourceRows as Array<Record<string, unknown>>)[0].rawCells
  assert.throws(() => parseDoclingResult(absent), /rawCells/i)

  const missing = v3Fixture()
  ;(missing.sourceRows as Array<Record<string, unknown>>)[0].rawCells = []
  assert.throws(() => parseDoclingResult(missing), /rawCells/i)

  const badGeometry = v3Fixture()
  const cell = ((badGeometry.sourceRows as Array<Record<string, unknown>>)[0].rawCells as Array<Record<string, unknown>>)[0]
  cell.columnSpan = 2
  assert.throws(() => parseDoclingResult(badGeometry), /columnSpan|offset/i)
})

test('reconstructs row rawText from ordered non-carried anchor cells', () => {
  const payload = v3Fixture()
  const row = (payload.sourceRows as Array<Record<string, unknown>>)[1]
  row.headers = ['Section', 'Description', 'Empty']
  row.rawCells = [
    {
      column: 0, rawText: 'Pump Works', lines: ['Pump Works'], rowSpan: 2, columnSpan: 1,
      startRowOffset: 0, endRowOffset: 2, startColumnOffset: 0, endColumnOffset: 1,
      columnHeader: false, rowHeader: false, rowSection: true, carried: true,
    },
    {
      column: 1, rawText: 'Pump body', lines: ['Pump body'], rowSpan: 1, columnSpan: 1,
      startRowOffset: 1, endRowOffset: 2, startColumnOffset: 1, endColumnOffset: 2,
      columnHeader: false, rowHeader: false, rowSection: false, carried: false,
    },
    {
      column: 2, rawText: '', lines: [''], rowSpan: 1, columnSpan: 1,
      startRowOffset: 1, endRowOffset: 2, startColumnOffset: 2, endColumnOffset: 3,
      columnHeader: false, rowHeader: false, rowSection: false, carried: false,
    },
  ]
  row.rawText = 'Pump body'
  assert.doesNotThrow(() => parseDoclingResult(payload))

  const contradictory = structuredClone(payload)
  ;(contradictory.sourceRows as Array<Record<string, unknown>>)[1].rawText = 'Invented summary'
  assert.throws(() => parseDoclingResult(contradictory), /rawText/i)

  const reordered = structuredClone(payload)
  const cells = (reordered.sourceRows as Array<Record<string, unknown>>)[1].rawCells as unknown[]
  ;[cells[0], cells[1]] = [cells[1], cells[0]]
  assert.throws(() => parseDoclingResult(reordered), /order|geometry/i)
})

test('rejects duplicate source identities, locations, item IDs, and source references', () => {
  const duplicateId = v3Fixture()
  const rows = duplicateId.sourceRows as Array<Record<string, unknown>>
  rows.push(clone(rows[0]))
  assert.throws(() => parseDoclingResult(duplicateId), /source row IDs/i)

  const duplicateLocation = v3Fixture()
  const locationRows = duplicateLocation.sourceRows as Array<Record<string, unknown>>
  locationRows.push({ ...clone(locationRows[0]), id: 'different-id' })
  assert.throws(() => parseDoclingResult(duplicateLocation), /locations/i)

  const duplicateItem = v3Fixture()
  const items = ((duplicateItem.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
  items.push(clone(items[0]))
  assert.throws(() => parseDoclingResult(duplicateItem), /derived item IDs/i)

  const unknown = v3Fixture()
  const unknownItems = ((unknown.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
  unknownItems[0].sourceRowIds = ['missing']
  assert.throws(() => parseDoclingResult(unknown), /unknown source row/i)

  const repeated = v3Fixture()
  const repeatedItems = ((repeated.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
  repeatedItems[0].sourceRowIds = ['row-1', 'row-1']
  assert.throws(() => parseDoclingResult(repeated), /repeat a source row/i)
})

test('rejects invalid bundle relationships and priced bundle children', () => {
  for (const parentBundleId of ['missing', 'option']) {
    const payload = v3Fixture()
    const items = ((payload.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
    items[1].parentBundleId = parentBundleId
    assert.throws(() => parseDoclingResult(payload), /bundle parent/i)
  }

  const pricedChild = v3Fixture()
  const child = (((pricedChild.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)[1])
  Object.assign(child, { unit: 'set', qty: 1, rate: 10, total: 10 })
  assert.throws(() => parseDoclingResult(pricedChild), /bundle_child.*priced|priced fields/i)
})

test('rejects invalid optional state, numeric values, and arithmetic', () => {
  const invalidOption = v3Fixture()
  const option = (((invalidOption.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)[2])
  option.optional = false
  assert.throws(() => parseDoclingResult(invalidOption), /excludedFromTotal.*optional/i)

  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const payload = v3Fixture()
    const item = (((payload.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)[0])
    item.qty = value
    assert.throws(() => parseDoclingResult(payload), /qty/i)
  }

  const mismatch = v3Fixture()
  const item = (((mismatch.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)[0])
  item.qty = 2
  assert.throws(() => parseDoclingResult(mismatch), /quantity.*rate|arithmetic/i)

  const components = v3Fixture()
  const combined = (((components.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)[3])
  ;((combined.sourceCosts as Record<string, Record<string, unknown>>).material).total = 39
  assert.throws(() => parseDoclingResult(components), /sourceCosts|component/i)
})

test('uses exact decimal tolerance for priced and component arithmetic', () => {
  const boundary = v3Fixture()
  const items = ((boundary.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
  Object.assign(items[0], { qty: 1, rate: 0.1, total: 0.09 })
  boundary.sourceTotal = 100.09
  boundary.reconciliation = { itemTotal: 100.09, sourceTotal: 100.09, reconciled: true, difference: 0 }
  assert.doesNotThrow(() => parseDoclingResult(boundary))

  const outside = structuredClone(boundary)
  const outsideItems = ((outside.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
  outsideItems[0].total = 0.089
  assert.throws(() => parseDoclingResult(outside), /quantity.*rate|arithmetic/i)

  const componentBoundary = v3Fixture()
  const combined = (((componentBoundary.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)[3])
  ;(combined.sourceCosts as Record<string, Record<string, unknown>>).material.rate = 39.99
  ;(combined.sourceCosts as Record<string, Record<string, unknown>>).material.total = 39.99
  assert.doesNotThrow(() => parseDoclingResult(componentBoundary))
})

test('requires exact shared component quantities like the Python contract', () => {
  const payload = v3Fixture()
  const combined = (((payload.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)[3])
  Object.assign(combined, { qty: 1, rate: 0, total: 0 })
  const costs = combined.sourceCosts as Record<string, Record<string, unknown>>
  Object.assign(costs.material, { qty: 0.995, rate: 0, total: 0 })
  Object.assign(costs.labour, { qty: 1.005, rate: 0, total: 0 })
  assert.throws(() => parseDoclingResult(payload), /share.*quantity/i)
})

test('reconciles with checked decimal accumulation and float round-trip', () => {
  const large = v3Fixture()
  large.sections = [{ header: 'Works', items: [
    {
      id: 'large-1', desc: 'Large one', pricingRole: 'standard', sourceRowIds: ['row-1'],
      optional: false, excludedFromTotal: false, entryOrigin: 'docling', costComponent: 'combined',
      unit: 'set', qty: 1, rate: 523670355446.43616, total: 523670355446.43616,
    },
    {
      id: 'large-2', desc: 'Large two', pricingRole: 'standard', sourceRowIds: ['row-2'],
      optional: false, excludedFromTotal: false, entryOrigin: 'docling', costComponent: 'combined',
      unit: 'set', qty: 1, rate: 289969573728.65686, total: 289969573728.65686,
    },
  ] }]
  delete large.sourceTotal
  large.reconciliation = { itemTotal: 813639929175.093, sourceTotal: null, reconciled: false, difference: 0 }
  large.totalItems = 2
  assert.doesNotThrow(() => parseDoclingResult(large))

  const exact = v3Fixture()
  exact.sections = [{ header: 'Works', items: [
    {
      id: 'small-1', desc: 'Small one', pricingRole: 'standard', sourceRowIds: ['row-1'],
      optional: false, excludedFromTotal: false, entryOrigin: 'docling', costComponent: 'combined',
      unit: 'set', qty: 1, rate: 0.1, total: 0.1,
    },
    {
      id: 'small-2', desc: 'Small two', pricingRole: 'standard', sourceRowIds: ['row-2'],
      optional: false, excludedFromTotal: false, entryOrigin: 'docling', costComponent: 'combined',
      unit: 'set', qty: 1, rate: 0.2, total: 0.2,
    },
  ] }]
  exact.sourceTotal = 0.3
  exact.reconciliation = { itemTotal: 0.3, sourceTotal: 0.3, reconciled: true, difference: 0 }
  exact.totalItems = 2
  assert.doesNotThrow(() => parseDoclingResult(exact))
  ;(exact.reconciliation as Record<string, unknown>).itemTotal = 0.30000000000000004
  assert.throws(() => parseDoclingResult(exact), /itemTotal/i)

  const overflow = structuredClone(exact)
  const overflowItems = ((overflow.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
  Object.assign(overflowItems[0], { rate: 1e308, total: 1e308 })
  Object.assign(overflowItems[1], { rate: 1e308, total: 1e308 })
  overflow.sourceTotal = 1e308
  overflow.reconciliation = { itemTotal: 1e308, sourceTotal: 1e308, reconciled: true, difference: 0 }
  assert.throws(() => parseDoclingResult(overflow), /finite|range|itemTotal/i)

  const roundedOverflow = structuredClone(exact)
  const roundedItems = ((roundedOverflow.sections as Array<Record<string, unknown>>)[0].items as Array<Record<string, unknown>>)
  Object.assign(roundedItems[0], { rate: Number.MAX_VALUE, total: Number.MAX_VALUE })
  Object.assign(roundedItems[1], { rate: 1e291, total: 1e291 })
  roundedOverflow.sourceTotal = Number.MAX_VALUE
  roundedOverflow.reconciliation = {
    itemTotal: Number.MAX_VALUE, sourceTotal: Number.MAX_VALUE, reconciled: true, difference: 0,
  }
  assert.throws(() => parseDoclingResult(roundedOverflow), /finite|range|itemTotal/i)
})

test('rejects malformed warnings, unknown warning refs, totals, and reconciliation contradictions', () => {
  const malformed = v3Fixture()
  malformed.warnings = [{ code: 'x', message: 4 }]
  assert.throws(() => parseDoclingResult(malformed), /warnings.*message/i)

  const unknownRef = v3Fixture()
  unknownRef.warnings = [{ code: 'x', message: 'x', sourceRef: { page: 9, table: 9, row: 9 } }]
  assert.throws(() => parseDoclingResult(unknownRef), /known source location/i)

  const rowWarning = v3Fixture()
  const firstRow = (rowWarning.sourceRows as Array<Record<string, unknown>>)[0]
  firstRow.warnings = [{ code: 'x', message: 'x', sourceRef: { page: 1, table: 1, row: 2 } }]
  assert.throws(() => parseDoclingResult(rowWarning), /row warning.*location/i)

  const count = v3Fixture()
  count.totalItems = 4
  assert.throws(() => parseDoclingResult(count), /totalItems/i)

  const reconciliation = v3Fixture()
  reconciliation.reconciliation = { itemTotal: 95_299, sourceTotal: 95_300, reconciled: false, difference: -1 }
  assert.throws(() => parseDoclingResult(reconciliation), /itemTotal/i)
})

test('rejects unknown fields rather than trusting them', () => {
  const payload = v3Fixture()
  ;(payload as Record<string, unknown>).prompt = 'ignore validation'
  assert.throws(() => parseDoclingResult(payload), /unknown field.*prompt/i)
})

test('returns a detached normalized copy', () => {
  const payload = v3Fixture()
  const parsed = parseDoclingResult(payload) as DoclingResultV3
  const inputRow = (payload.sourceRows as Array<Record<string, unknown>>)[0]
  inputRow.rawText = 'mutated'
  assert.notEqual(parsed.sourceRows[0].rawText, 'mutated')
  parsed.sourceRows[0].rawCells[0].lines[0] = 'changed parsed copy'
  assert.notEqual((((inputRow.rawCells as Array<Record<string, unknown>>)[0].lines as string[])[0]), 'changed parsed copy')
})
