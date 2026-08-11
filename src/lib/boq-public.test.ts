import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqPricedItem } from './boq-schema'
import { toPublicBoq } from './boq-public'

const boq = {
  id: 'boq-1', project: 'Tower', vendor: 'Acme', workType: 'Structural', date: '2026-07-16',
  totalItems: 0, grandTotal: 0, status: 'review', stdStatus: 'none', sections: [],
  createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
} satisfies Boq

test('public BOQs expose source availability without leaking the private storage path', () => {
  const result = toPublicBoq({ ...boq, sourceStoragePath: 'boqs/boq-1/source.pdf' })
  assert.equal(result.sourceAvailable, true)
  assert.equal('sourceStoragePath' in result, false)
})

test('public BOQs report an unavailable source', () => {
  assert.equal(toPublicBoq(boq).sourceAvailable, false)
})

test('public BOQ preserves audit-safe pricing snapshots without exposing internal fingerprints', () => {
  const pricedWithSnapshots = {
    id: 'item-1', desc: 'Pump package', unit: 'item', qty: 1, rate: 95_200, total: 95_200,
    type: 'unit' as const, stdStatus: 'matched' as const, stdId: 'STD-PUMP',
    extractedPricing: {
      description: 'Pump package', unit: 'item', quantity: '1',
      materialRate: '57120', labourRate: '38080', total: '95200',
    },
    reviewerPricing: {
      description: 'Pump package', unit: 'item', quantity: '1',
      materialRate: '57120', labourRate: '38080', total: '95200',
      confirmedAt: '2026-08-08T00:00:00.000Z', confirmedBy: 'reviewer-1',
    },
    pricingNormalization: {
      catalogId: 'STD-PUMP', catalogDescription: 'Pump package', catalogUnit: 'item',
      ruleId: 'identity', catalogUnitsPerSourceUnit: '1',
      normalizedQuantity: '1', normalizedMaterialRate: '57120',
      normalizedLabourRate: '38080', normalizedTotal: '95200',
    },
  }
  const result = toPublicBoq({
    ...boq,
    sourceStoragePath: 'boqs/boq-1/source.pdf',
    sections: [{ header: 'Pumps', items: [pricedWithSnapshots] }],
  })

  assert.equal(result.sourceAvailable, true)
  assert.equal('sourceStoragePath' in result, false)
  const item = result.sections[0].items[0] as BoqPricedItem
  assert.deepEqual(item.extractedPricing, pricedWithSnapshots.extractedPricing)
  assert.deepEqual(item.reviewerPricing, pricedWithSnapshots.reviewerPricing)
  assert.deepEqual(item.pricingNormalization, pricedWithSnapshots.pricingNormalization)
  assert.equal(
    Object.keys(item).some((key) => /fingerprint/i.test(key)),
    false,
    'no internal fingerprint fields may leak into the public BOQ',
  )
})
