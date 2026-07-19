import assert from 'node:assert/strict'
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
