import assert from 'node:assert/strict'
import test from 'node:test'

import { parseBoqListLimit } from '../boqs/route'
import { computeBoqStdStatus, itemMatchesStandardCanonically, updateLinkedBoqsForStandard } from './[id]/route'
import {
  applyStandardToBoqItem,
  mergeStandardSourceItems,
  normalizeStandardEntry,
  queryStandards,
} from './route'

test('normalizeStandardEntry backfills legacy aliases and sourceItems', () => {
  const normalized = normalizeStandardEntry({
    id: 'std-1',
    description: 'Concrete',
    unit: 'm³',
    sourceBoqCount: 0,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  } as unknown as Parameters<typeof normalizeStandardEntry>[0])

  assert.deepEqual(normalized.aliases, [])
  assert.deepEqual(normalized.sourceItems, [])
})

test('queryStandards excludes archived entries by default and searches description, unit, and aliases', () => {
  const results = queryStandards(
    [
      {
        id: 'std-active',
        description: 'Concrete pump',
        unit: 'day',
        aliases: ['pump rental'],
        sourceItems: undefined,
        sourceBoqCount: 1,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
      {
        id: 'std-archived',
        description: 'Formwork',
        unit: 'm²',
        aliases: ['shuttering'],
        sourceItems: undefined,
        sourceBoqCount: 1,
        archivedAt: '2026-07-13T00:00:00.000Z',
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    ],
    { search: 'day' },
  )

  assert.equal(results.length, 1)
  assert.equal(results[0]?.id, 'std-active')
  assert.deepEqual(results[0]?.sourceItems, [])
})

test('applyStandardToBoqItem canonicalizes the BOQ item while preserving original source fields', () => {
  const updated = applyStandardToBoqItem(
    {
      code: 'A-1',
      desc: 'Site mixed concrete',
      unit: 'm3',
      qty: 2,
      rate: 100,
      total: 200,
      type: 'unit',
      stdStatus: 'unmatched',
    },
    {
      id: 'std-1',
      description: 'Ready-mix concrete',
      unit: 'm³',
      aliases: [],
      sourceItems: [],
      sourceBoqCount: 0,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    },
    'manual',
  )

  assert.equal(updated.stdId, 'std-1')
  assert.equal(updated.desc, 'Ready-mix concrete')
  assert.equal(updated.unit, 'm³')
  assert.equal(updated.stdMatch, 'Ready-mix concrete')
  assert.equal(updated.stdStatus, 'matched')
  assert.equal(updated.stdConfidence, 'manual')
  assert.equal(updated.sourceDesc, 'Site mixed concrete')
  assert.equal(updated.sourceUnit, 'm3')
})

test('mergeStandardSourceItems deduplicates and recomputes sourceBoqCount', () => {
  const merged = mergeStandardSourceItems(
    {
      id: 'std-1',
      description: 'Ready-mix concrete',
      unit: 'm³',
      aliases: [],
      sourceItems: [
        {
          boqId: 'boq-1',
          sectionIndex: 0,
          itemCode: 'A-1',
          sourceDescription: 'Site mixed concrete',
        },
      ],
      sourceBoqCount: 1,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    },
    {
      boqId: 'boq-2',
      sectionIndex: 1,
      itemCode: 'B-1',
      sourceDescription: 'Ready mixed concrete',
    },
    '2026-07-13T12:00:00.000Z',
  )

  assert.equal(merged.sourceItems?.length, 2)
  assert.equal(merged.sourceBoqCount, 2)
  assert.equal(merged.lastMatched, '2026-07-13T12:00:00.000Z')

  const deduped = mergeStandardSourceItems(
    merged,
    {
      boqId: 'boq-2',
      sectionIndex: 1,
      itemCode: 'B-1',
      sourceDescription: 'Ready mixed concrete',
    },
    '2026-07-13T13:00:00.000Z',
  )

  assert.equal(deduped.sourceItems?.length, 2)
  assert.equal(deduped.sourceBoqCount, 2)
})

test('computeBoqStdStatus returns none, partial, and complete based on matched items', () => {
  assert.equal(computeBoqStdStatus([{ header: 'Empty', items: [] }]), 'none')
  assert.equal(
    computeBoqStdStatus([
      {
        header: 'Section',
        items: [
          { code: 'A', desc: 'One', unit: 'm', qty: 1, rate: 1, total: 1, type: 'unit', stdStatus: 'matched' },
          { code: 'B', desc: 'Two', unit: 'm', qty: 1, rate: 1, total: 1, type: 'unit', stdStatus: 'unmatched' },
        ],
      },
    ]),
    'partial',
  )
  assert.equal(
    computeBoqStdStatus([
      {
        header: 'Section',
        items: [
          { code: 'A', desc: 'One', unit: 'm', qty: 1, rate: 1, total: 1, type: 'unit', stdStatus: 'matched' },
        ],
      },
    ]),
    'complete',
  )
})

test('updateLinkedBoqsForStandard updates linked items and preserves original source fields', () => {
  const { boqs, affectedItems } = updateLinkedBoqsForStandard(
    [
      {
        id: 'boq-1',
        project: 'Tower',
        vendor: 'Vendor',
        workType: 'Structural',
        date: '2026-07-13',
        totalItems: 1,
        grandTotal: 100,
        status: 'active',
        stdStatus: 'partial',
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
        sections: [
          {
            header: 'Concrete',
            items: [
              {
                code: 'A-1',
                desc: 'Old canonical',
                unit: 'm3',
                qty: 1,
                rate: 100,
                total: 100,
                type: 'unit',
                stdId: 'std-1',
                stdStatus: 'matched',
              },
            ],
          },
        ],
      },
    ],
    {
      id: 'std-1',
      description: 'New canonical',
      unit: 'm³',
      aliases: ['concrete'],
      sourceItems: [],
      sourceBoqCount: 1,
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    },
  )

  assert.equal(affectedItems, 1)
  assert.equal(boqs[0]?.sections[0]?.items[0]?.desc, 'New canonical')
  assert.equal(boqs[0]?.sections[0]?.items[0]?.unit, 'm³')
  assert.equal(boqs[0]?.sections[0]?.items[0]?.stdMatch, 'New canonical')
  assert.equal(boqs[0]?.sections[0]?.items[0]?.sourceDesc, 'Old canonical')
  assert.equal(boqs[0]?.sections[0]?.items[0]?.sourceUnit, 'm3')
})

test('itemMatchesStandardCanonically detects legacy canonical links', () => {
  assert.equal(
    itemMatchesStandardCanonically(
      {
        code: 'A-1',
        desc: 'Ready-mix concrete',
        unit: 'm³',
        qty: 1,
        rate: 1,
        total: 1,
        type: 'unit',
        stdStatus: 'matched',
      },
      {
        id: 'std-1',
        description: 'Ready-mix concrete',
        unit: 'm³',
        aliases: [],
        sourceItems: [],
        sourceBoqCount: 0,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    ),
    true,
  )
})

test('parseBoqListLimit keeps the existing default but allows the catalog page max of 1000', () => {
  assert.equal(parseBoqListLimit(null), 10)
  assert.equal(parseBoqListLimit('1000'), 1000)
  assert.equal(parseBoqListLimit('1500'), 1000)
})
