import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyComponentCostEdit,
  buildUnifiedBoqSections,
  componentCostView,
  initializeComponentAllocation,
  isPricedUnifiedBoqRow,
} from './boq-unified-rows'
import type { BoqPricedItem, BoqSection } from './boq-schema'

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return {
    id: 'item-1',
    desc: 'Valve installation',
    unit: 'Pcs',
    qty: 8,
    rate: 100,
    total: 800,
    type: 'unit',
    costComponent: 'combined',
    stdStatus: 'unmatched',
    ...overrides,
  }
}

test('keeps independent material and labour source rows as distinct unified rows', () => {
  const sections: BoqSection[] = [{
    header: 'Valves',
    items: [
      item({ id: 'material-1', unit: 'Pcs', qty: 8, costComponent: 'material', sourceRef: { page: 1, table: 1, row: 7 } }),
      item({ id: 'labour-1', unit: 'Db', qty: 48, costComponent: 'labour', sourceRef: { page: 1, table: 1, row: 7 } }),
    ],
  }]

  const rows = buildUnifiedBoqSections(sections)[0]!.rows

  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => ({
    key: row.key,
    unit: isPricedUnifiedBoqRow(row) ? row.item.unit : undefined,
    qty: isPricedUnifiedBoqRow(row) ? row.item.qty : undefined,
  })), [
    { key: 'section:0:id:material-1', unit: 'Pcs', qty: 8 },
    { key: 'section:0:id:labour-1', unit: 'Db', qty: 48 },
  ])
})

test('uses a stable item ID before legacy row-position fallback', () => {
  const sections: BoqSection[] = [{
    header: 'Section',
    items: [item({ id: '  stable-id  ', code: 'legacy-code' }), item({ id: undefined, code: undefined })],
  }]

  const rows = buildUnifiedBoqSections(sections)[0]!.rows

  assert.equal(rows[0]!.key, 'section:0:id:stable-id')
  assert.equal(rows[1]!.key, 'section:0:item:1')
})

test('annotates each unified row with its global identity validity', () => {
  const sections: BoqSection[] = [
    { header: 'A', items: [item({ id: 'unique' })] },
    {
      header: 'B',
      items: [
        item({ id: undefined, code: undefined }),
        item({ id: undefined, code: 'DUP' }),
      ],
    },
    { header: 'C', items: [item({ id: undefined, code: 'DUP' })] },
  ]

  const rows = buildUnifiedBoqSections(sections).flatMap((section) => section.rows)

  assert.deepEqual(rows.map((row) => ({
    identityKey: row.identityKey,
    identityIssue: row.identityIssue,
  })), [
    { identityKey: 'id:unique', identityIssue: undefined },
    { identityKey: undefined, identityIssue: 'missing' },
    { identityKey: 'code:DUP', identityIssue: 'ambiguous' },
    { identityKey: 'code:DUP', identityIssue: 'ambiguous' },
  ])
})

test('namespaces stable identities by section so catalog row state cannot collide', () => {
  const sections: BoqSection[] = [
    { header: 'Materials', items: [item({ id: 'reused-import-id', code: 'VALVE' })] },
    { header: 'Labour', items: [item({ id: 'reused-import-id', code: 'VALVE' })] },
  ]

  const rows = buildUnifiedBoqSections(sections).flatMap((section) => section.rows)

  assert.deepEqual(rows.map((row) => row.key), [
    'section:0:id:reused-import-id',
    'section:1:id:reused-import-id',
  ])
  assert.notEqual(rows[0]!.key, rows[1]!.key)
})

test('preserves source section order and original item indexes', () => {
  const sections: BoqSection[] = [
    { header: 'First', items: [item({ id: 'first-a' }), item({ id: 'first-b' })] },
    { header: 'Second', items: [item({ id: 'second-a' })] },
  ]

  const unified = buildUnifiedBoqSections(sections)

  assert.deepEqual(unified.map((section) => ({
    header: section.header,
    sectionIndex: section.sectionIndex,
    itemIndexes: section.rows.map((row) => row.itemIndex),
  })), [
    { header: 'First', sectionIndex: 0, itemIndexes: [0, 1] },
    { header: 'Second', sectionIndex: 1, itemIndexes: [0] },
  ])
})

test('exposes a material row cost without changing its quantity', () => {
  const source = item({ costComponent: 'material', qty: 8, unit: 'Pcs', rate: 2808, total: 22464 })

  assert.deepEqual(componentCostView(source), {
    basis: 'rate', material: 2808, labour: 0, allocationRequired: false,
  })
  assert.equal(source.qty, 8)
  assert.equal(source.unit, 'Pcs')
})

test('exposes a labour row cost without changing its quantity', () => {
  const source = item({ costComponent: 'labour', qty: 48, unit: 'Db', rate: 300, total: 14400 })

  assert.deepEqual(componentCostView(source), {
    basis: 'rate', material: 0, labour: 300, allocationRequired: false,
  })
  assert.equal(source.qty, 48)
  assert.equal(source.unit, 'Db')
})

test('reads both parsed component rates from a combined source row', () => {
  const source = item({
    sourceCosts: {
      material: { present: true, qty: 8, unit: 'Pcs', rate: 2808, total: 22464 },
      labour: { present: true, qty: 48, unit: 'Db', rate: 300, total: 14400 },
    },
  })

  assert.deepEqual(componentCostView(source), {
    basis: 'rate', material: 2808, labour: 300, allocationRequired: false,
  })
})

test('marks an unknown combined split for explicit allocation without mutating it', () => {
  const source = item({ costComponent: 'combined', sourceCosts: undefined })

  assert.deepEqual(componentCostView(source), {
    basis: null, material: null, labour: null, allocationRequired: true,
  })
  assert.throws(() => applyComponentCostEdit(source, 'material', 60), /allocation/i)
  assert.equal(source.rate, 100)
  assert.equal(source.total, 800)
})

test('edits one allocated component through the shared allocation arithmetic', () => {
  const source = initializeComponentAllocation(item({ qty: 3, rate: 100, total: 300 }), 65, 35)
  const updated = applyComponentCostEdit(source, 'labour', 45)

  assert.deepEqual(componentCostView(updated), {
    basis: 'rate', material: 65, labour: 45, allocationRequired: false,
  })
  assert.equal(updated.rate, 110)
  assert.equal(updated.total, 330)
})

test('uses total allocation basis for lump-sum components', () => {
  const source = initializeComponentAllocation(item({ type: 'lump_sum', qty: 1, unit: 'L/S' }), 200, 150)

  assert.deepEqual(componentCostView(source), {
    basis: 'total', material: 200, labour: 150, allocationRequired: false,
  })
  assert.equal(source.total, 350)
  assert.equal(source.rate, 350)
})

test('rejects invalid component allocations and edits', () => {
  assert.throws(() => initializeComponentAllocation(item(), -1, 10), /non-negative/i)
  const allocated = initializeComponentAllocation(item(), 60, 40)
  assert.throws(() => applyComponentCostEdit(allocated, 'material', Number.NaN), /finite/i)
})
