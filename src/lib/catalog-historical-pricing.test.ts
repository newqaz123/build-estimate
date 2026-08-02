import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqPricedItem } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import {
  buildCatalogComponentPricing,
  buildCatalogHistoricalPricing,
} from './catalog-historical-pricing'

const now = '2026-07-18T00:00:00.000Z'

function item(id: string, rate: number, overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return {
    id,
    desc: 'Pipe 6 inch',
    unit: 'pcs',
    qty: 1,
    rate,
    total: rate,
    type: 'unit',
    stdStatus: 'matched',
    stdId: 'std-pipe',
    ...overrides,
  }
}

function boq(id: string, status: Boq['status'], boqItem: BoqPricedItem): Boq {
  return {
    id,
    project: `Project ${id}`,
    vendor: `Vendor ${id}`,
    workType: 'MEP',
    date: '2026-07-18',
    totalItems: 1,
    grandTotal: boqItem.total,
    status,
    stdStatus: boqItem.stdStatus === 'matched' ? 'complete' : 'none',
    sections: [{ header: 'Pipework', items: [boqItem] }],
    createdAt: now,
    updatedAt: now,
  }
}

function sourceCost(
  present: boolean,
  qty: number,
  unit: string,
  rate: number,
) {
  return {
    present,
    qty,
    unit,
    rate,
    total: qty * rate,
  }
}

const standard: StandardEntry = {
  id: 'std-pipe',
  description: 'Pipe 6 inch',
  unit: 'pcs',
  aliases: [],
  sourceBoqCount: 2,
  sourceItems: [{ boqId: 'legacy', sectionIndex: 0, itemId: 'legacy-item', sourceDescription: '6 inch pipe' }],
  createdAt: now,
  updatedAt: now,
}

test('historical pricing includes only approved explicitly matched compatible rates', () => {
  const pricing = buildCatalogHistoricalPricing([standard], [
    boq('approved', 'approved', item('approved-item', 100)),
    boq('legacy', 'approved', item('legacy-item', 120, { stdId: undefined, sourceDesc: '6 inch pipe' })),
    boq('draft', 'draft', item('draft-item', 999)),
    boq('unmatched', 'approved', item('unmatched-item', 80, { stdStatus: 'unmatched' })),
    boq('excluded', 'approved', item('excluded-item', 70, { stdStatus: 'excluded', stdExclusionReason: 'One-off' })),
    boq('wrong-unit', 'approved', item('wrong-unit-item', 60, { unit: 'DB' })),
    boq('zero', 'approved', item('zero-item', 0)),
  ])

  assert.deepEqual(pricing.get('std-pipe'), {
    count: 2,
    min: 100,
    average: 110,
    max: 120,
    sources: [
      {
        boqId: 'approved', project: 'Project approved', vendor: 'Vendor approved', date: '2026-07-18',
        section: 'Pipework', itemId: 'approved-item', description: 'Pipe 6 inch', unit: 'pcs', rate: 100,
      },
      {
        boqId: 'legacy', project: 'Project legacy', vendor: 'Vendor legacy', date: '2026-07-18',
        section: 'Pipework', itemId: 'legacy-item', description: 'Pipe 6 inch', unit: 'pcs', rate: 120,
      },
    ],
  })
})

test('historical pricing excludes the selected BOQ without changing catalog history', () => {
  const boqs = [
    boq('selected', 'approved', item('selected-item', 150)),
    boq('prior', 'approved', item('prior-item', 100)),
  ]

  assert.equal(buildCatalogHistoricalPricing([standard], boqs).get('std-pipe')?.average, 125)
  assert.deepEqual(buildCatalogHistoricalPricing([standard], boqs, {}, { excludeBoqId: 'selected' }).get('std-pipe'), {
    count: 1,
    min: 100,
    average: 100,
    max: 100,
    sources: [{
      boqId: 'prior', project: 'Project prior', vendor: 'Vendor prior', date: '2026-07-18',
      section: 'Pipework', itemId: 'prior-item', description: 'Pipe 6 inch', unit: 'pcs', rate: 100,
    }],
  })
})

test('material and labour units remain independent histories', () => {
  const welding: StandardEntry = { ...standard, id: 'std-weld', description: 'Welding', unit: 'DB', sourceItems: [] }
  const pipeBoq = boq('pipe', 'approved', item('pipe-item', 100))
  const weldingBoq = boq('weld', 'approved', item('weld-item', 40, { desc: 'Welding', unit: 'DB', stdId: 'std-weld' }))
  const pricing = buildCatalogHistoricalPricing([standard, welding], [pipeBoq, weldingBoq])

  assert.equal(pricing.get('std-pipe')?.average, 100)
  assert.equal(pricing.get('std-weld')?.average, 40)
})

test('groups native material and labour rates by independent canonical units', () => {
  const priorOne = boq('prior-1', 'approved', item('stub-end-1', 4608, {
    sourceCosts: {
      material: sourceCost(true, 8, 'Pcs', 2808),
      labour: sourceCost(true, 48, 'Db', 300),
    },
  }))
  const priorTwo = boq('prior-2', 'approved', item('stub-end-2', 4500, {
    sourceCosts: {
      material: sourceCost(true, 8, 'pc', 2700),
      labour: sourceCost(true, 48, 'db', 285),
    },
  }))

  const pricing = buildCatalogComponentPricing(
    [standard],
    [priorOne, priorTwo],
    { pcs: 'piece', pc: 'piece', db: 'joint' },
  )

  assert.deepEqual(pricing.get('std-pipe')?.material.get('piece'), {
    unit: 'piece',
    count: 2,
    min: 2700,
    average: 2754,
    max: 2808,
  })
  assert.deepEqual(pricing.get('std-pipe')?.labour.get('joint'), {
    unit: 'joint',
    count: 2,
    min: 285,
    average: 292.5,
    max: 300,
  })
})

test('keeps incompatible native component units in separate buckets', () => {
  const perJoint = boq('joint', 'approved', item('joint-item', 100, {
    sourceCosts: {
      material: sourceCost(false, 0, '', 0),
      labour: sourceCost(true, 12, 'Db', 260),
    },
  }))
  const perLot = boq('lot', 'approved', item('lot-item', 100, {
    sourceCosts: {
      material: sourceCost(false, 0, '', 0),
      labour: sourceCost(true, 1, 'Lot', 1000),
    },
  }))

  const pricing = buildCatalogComponentPricing(
    [standard],
    [perJoint, perLot],
  ).get('std-pipe')

  assert.equal(pricing?.labour.get('db')?.average, 260)
  assert.equal(pricing?.labour.get('lot')?.average, 1000)
  assert.equal(pricing?.labour.size, 2)
})
