import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq, BoqItem } from './boq-schema'
import { collectCatalogReviewItems } from './catalog-review-queue'

const now = '2026-07-17T00:00:00.000Z'

function item(id: string, stdStatus: BoqItem['stdStatus']): BoqItem {
  return { id, desc: id, unit: 'm', qty: 1, rate: 10, total: 10, type: 'unit', stdStatus }
}

function boq(id: string, status: Boq['status'], items: BoqItem[]): Boq {
  return { id, project: id, vendor: 'Vendor', workType: 'MEP', date: '2026-07-17', totalItems: items.length, grandTotal: 10, status, stdStatus: 'partial', sections: [{ header: 'Work', items }], createdAt: now, updatedAt: now }
}

test('review queue includes draft unresolved items and excludes rejected or resolved items', () => {
  const result = collectCatalogReviewItems([
    boq('draft', 'draft', [item('draft-pending', 'pending'), item('draft-unmatched', 'unmatched'), item('draft-matched', 'matched')]),
    boq('approved', 'approved', [item('legacy-approved', 'unmatched'), item('approved-excluded', 'excluded')]),
    boq('rejected', 'rejected', [item('rejected-unmatched', 'unmatched')]),
  ])

  assert.deepEqual(result.map((entry) => [entry.boqId, entry.boqStatus, entry.id]), [
    ['draft', 'draft', 'draft-pending'],
    ['draft', 'draft', 'draft-unmatched'],
    ['approved', 'approved', 'legacy-approved'],
  ])
})
