import assert from 'node:assert/strict'
import test from 'node:test'

import type { BoqSourceRowV3, DoclingRawCellV3 } from './boq-extraction-schema'
import {
  resolveSourceCellMapping,
  type SourceCellMapping,
  type SourceCellMappingFailureCode,
} from './boq-extraction-cell-mapping'

function cell(column: number, rawText: string, lines = [rawText]): DoclingRawCellV3 {
  return {
    column,
    rawText,
    lines,
    rowSpan: 1,
    columnSpan: 1,
    startRowOffset: 0,
    endRowOffset: 1,
    startColumnOffset: column,
    endColumnOffset: column + 1,
    columnHeader: false,
    rowHeader: false,
    rowSection: false,
    carried: false,
  }
}

const pricedSourceRow: BoqSourceRowV3 = {
  id: 'row-1',
  page: 2,
  table: 1,
  row: 3,
  section: null,
  headers: [],
  rawCells: [
    cell(0, 'A.1'),
    cell(1, 'Relocating the entrance door'),
    cell(2, 'm2'),
    cell(3, '18'),
    cell(4, '980'),
    cell(5, '17,640'),
    cell(6, '650'),
    cell(7, '11,700'),
    cell(8, '29,340'),
  ],
  rawText: 'A.1 | Relocating the entrance door | m2 | 18 | 980 | 17,640 | 650 | 11,700 | 29,340',
  classification: 'unknown',
  confidence: 0.96,
  warnings: [],
}

const completeComponentMapping: SourceCellMapping = {
  sourceRowIds: ['row-1'],
  description: [{ sourceRowId: 'row-1', column: 1 }],
  unit: { sourceRowId: 'row-1', column: 2 },
  quantity: { sourceRowId: 'row-1', column: 3 },
  materialRate: { sourceRowId: 'row-1', column: 4 },
  materialTotal: { sourceRowId: 'row-1', column: 5 },
  labourRate: { sourceRowId: 'row-1', column: 6 },
  labourTotal: { sourceRowId: 'row-1', column: 7 },
  amount: { sourceRowId: 'row-1', column: 8 },
}

function resolve(mapping: SourceCellMapping, sourceRows: BoqSourceRowV3[] = [pricedSourceRow]) {
  return resolveSourceCellMapping({
    mapping,
    allowedSourceRowIds: new Set(['row-1']),
    sourceRows,
    section: { index: 0, header: 'Unsectioned' },
  })
}

function assertInvalid(mapping: SourceCellMapping, code: SourceCellMappingFailureCode, sourceRows = [pricedSourceRow]) {
  assert.deepEqual(resolve(mapping, sourceRows), { kind: 'invalid', code })
}

test('reconstructs a component-priced candidate solely from immutable source cells', () => {
  const result = resolve(completeComponentMapping)

  assert.equal(result.kind, 'candidate')
  assert.equal(result.candidate.desc, 'Relocating the entrance door')
  assert.equal(result.candidate.unit, 'm2')
  assert.equal(result.candidate.qty, 18)
  assert.equal(result.candidate.rate, 1_630)
  assert.equal(result.candidate.total, 29_340)
  assert.equal(result.candidate.costComponent, 'combined')
  assert.deepEqual(result.candidate.sourceCosts, {
    material: { qty: 18, unit: 'm2', rate: 980, total: 17_640 },
    labour: { qty: 18, unit: 'm2', rate: 650, total: 11_700 },
  })
  assert.deepEqual(result.candidate.sourceRefs, [{ page: 2, table: 1, row: 3 }])
  assert.match(result.candidate.id, /^mapped-[a-f0-9]{32}$/)
})

test('reconstructs generic prices and produces a stable evidence-sensitive ID', () => {
  const mapping: SourceCellMapping = {
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
    rate: { sourceRowId: 'row-1', column: 4 },
    total: { sourceRowId: 'row-1', column: 5 },
  }
  const first = resolve(mapping)
  const second = resolve({ ...mapping, sourceRowIds: [...mapping.sourceRowIds] })
  const changedEvidence = { ...pricedSourceRow, rawCells: pricedSourceRow.rawCells.map((value) => value.column === 1 ? cell(1, 'Different work') : value) }
  const changed = resolve(mapping, [changedEvidence])

  assert.equal(first.kind, 'candidate')
  assert.equal(second.kind, 'candidate')
  assert.equal(changed.kind, 'candidate')
  assert.equal(first.candidate.id, second.candidate.id)
  assert.notEqual(first.candidate.id, changed.candidate.id)
  assert.equal(first.candidate.rate, 980)
  assert.equal(first.candidate.total, 17_640)
  assert.equal(first.candidate.sourceCosts, null)
})

test('candidate identity covers retained cell geometry, not only displayed text', () => {
  const first = resolve(completeComponentMapping)
  const changedGeometry = {
    ...pricedSourceRow,
    rawCells: pricedSourceRow.rawCells.map((value) => value.column === 1
      ? { ...value, startColumnOffset: 10, endColumnOffset: 11 }
      : value),
  }
  const changed = resolve(completeComponentMapping, [changedGeometry])

  assert.equal(first.kind, 'candidate')
  assert.equal(changed.kind, 'candidate')
  assert.notEqual(first.candidate.id, changed.candidate.id)
})

test('rejects unknown, undeclared, and disallowed source rows', () => {
  assertInvalid({ ...completeComponentMapping, sourceRowIds: ['missing'] }, 'unknown_source_row')
  assertInvalid({ ...completeComponentMapping, description: [{ sourceRowId: 'row-2', column: 1 }] }, 'unknown_source_row')
  const result = resolveSourceCellMapping({
    mapping: completeComponentMapping,
    allowedSourceRowIds: new Set<string>(),
    sourceRows: [pricedSourceRow],
    section: { index: 0, header: 'Unsectioned' },
  })
  assert.deepEqual(result, { kind: 'invalid', code: 'unknown_source_row' })
})

test('rejects missing or ambiguous retained columns', () => {
  assertInvalid({ ...completeComponentMapping, unit: { sourceRowId: 'row-1', column: 99 } }, 'missing_source_cell')
  assertInvalid(completeComponentMapping, 'conflicting_binding', [{
    ...pricedSourceRow,
    rawCells: [...pricedSourceRow.rawCells, cell(2, 'duplicate')],
  }])
})

test('rejects invalid line indexes and resolves a valid line instead of rawText', () => {
  const row = {
    ...pricedSourceRow,
    rawCells: pricedSourceRow.rawCells.map((value) => value.column === 1
      ? cell(1, 'first\nsecond', ['first', 'second'])
      : value),
  }
  assertInvalid({ ...completeComponentMapping, description: [{ sourceRowId: 'row-1', column: 1, line: 2 }] }, 'invalid_line_index', [row])
  assertInvalid({ ...completeComponentMapping, description: [{ sourceRowId: 'row-1', column: 1, line: -1 }] }, 'invalid_line_index', [row])
  const result = resolve({ ...completeComponentMapping, description: [{ sourceRowId: 'row-1', column: 1, line: 1 }] }, [row])
  assert.equal(result.kind, 'candidate')
  assert.equal(result.candidate.desc, 'second')
})

test('rejects conflicting pricing shapes and reused source-cell bindings', () => {
  assertInvalid({ ...completeComponentMapping, rate: { sourceRowId: 'row-1', column: 4 } }, 'conflicting_binding')
  assertInvalid({ ...completeComponentMapping, unit: { sourceRowId: 'row-1', column: 1 } }, 'conflicting_binding')
  assertInvalid({ ...completeComponentMapping, unit: { sourceRowId: 'row-1', column: 1, line: 0 } }, 'conflicting_binding')
})

test('rejects blank values not retained in the referenced cell', () => {
  const blank = {
    ...pricedSourceRow,
    rawCells: pricedSourceRow.rawCells.map((value) => value.column === 2 ? cell(2, '   ') : value),
  }
  assertInvalid(completeComponentMapping, 'invalid_source_value', [blank])
})

test('strictly parses currency and commas but rejects malformed, negative, and non-finite numbers', () => {
  const generic: SourceCellMapping = {
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
    rate: { sourceRowId: 'row-1', column: 4 },
    total: { sourceRowId: 'row-1', column: 5 },
  }
  const currencyRow = { ...pricedSourceRow, rawCells: pricedSourceRow.rawCells.map((value) => value.column === 4 ? cell(4, 'THB 980.00') : value) }
  assert.equal(resolve(generic, [currencyRow]).kind, 'candidate')

  for (const bad of ['1,76,40', '(980)', '-980', 'Infinity', '1e309', 'NaN']) {
    const row = { ...pricedSourceRow, rawCells: pricedSourceRow.rawCells.map((value) => value.column === 4 ? cell(4, bad) : value) }
    assertInvalid(generic, 'invalid_source_value', [row])
  }
  const conflictingCurrencies = { ...pricedSourceRow, rawCells: pricedSourceRow.rawCells.map((value) => value.column === 4 ? cell(4, 'THB 980 USD') : value) }
  assertInvalid(generic, 'invalid_source_value', [conflictingCurrencies])
})

test('rejects retained integers and decimals that cannot round-trip without precision loss', () => {
  const generic: SourceCellMapping = {
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
    rate: { sourceRowId: 'row-1', column: 4 },
    total: { sourceRowId: 'row-1', column: 5 },
  }
  for (const lossy of ['9007199254740993', '0.1234567890123456789']) {
    const row = {
      ...pricedSourceRow,
      rawCells: pricedSourceRow.rawCells.map((value) => {
        if (value.column === 3) return cell(3, '1')
        if (value.column === 4 || value.column === 5) return cell(value.column, lossy)
        return value
      }),
    }
    assertInvalid(generic, 'invalid_source_value', [row])
  }
})

test('keeps exactly round-trippable source decimals valid and checks them with decimal arithmetic', () => {
  const row = {
    ...pricedSourceRow,
    rawCells: pricedSourceRow.rawCells.map((value) => {
      if (value.column === 3) return cell(3, '3')
      if (value.column === 4) return cell(4, 'THB 0.10')
      if (value.column === 5) return cell(5, '0.300')
      return value
    }),
  }
  const result = resolve({
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
    rate: { sourceRowId: 'row-1', column: 4 },
    total: { sourceRowId: 'row-1', column: 5 },
  }, [row])

  assert.equal(result.kind, 'candidate')
  assert.equal(result.candidate.rate, 0.1)
  assert.equal(result.candidate.total, 0.3)
})

test('rejects qty times rate inconsistencies', () => {
  const row = { ...pricedSourceRow, rawCells: pricedSourceRow.rawCells.map((value) => value.column === 5 ? cell(5, '17,000') : value) }
  assertInvalid(completeComponentMapping, 'arithmetic_mismatch', [row])
})

test('rejects component totals that do not sum to the mapped amount', () => {
  const row = { ...pricedSourceRow, rawCells: pricedSourceRow.rawCells.map((value) => value.column === 8 ? cell(8, '30,000') : value) }
  assertInvalid(completeComponentMapping, 'component_sum_mismatch', [row])
})

test('returns a source-backed draft with explicit missing fields for incomplete mappings', () => {
  const result = resolve({
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
  })

  assert.equal(result.kind, 'draft')
  assert.deepEqual(result.draft.missingFields, ['rate', 'total'])
  assert.deepEqual(result.draft.resolvedValues, {
    description: 'Relocating the entrance door',
    unit: 'm2',
    quantity: 18,
  })
  assert.deepEqual(result.draft.sourceRowIds, ['row-1'])
  assert.deepEqual(result.draft.sourceRefs, [{ page: 2, table: 1, row: 3 }])
  assert.deepEqual(result.draft.mapping, {
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
  })
})
