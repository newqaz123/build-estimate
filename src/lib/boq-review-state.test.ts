import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildReviewVerification,
  reviewItemKey,
  updateReviewItem,
} from './boq-review-state'
import type { Boq, BoqItem } from './boq-schema'

const item: BoqItem = {
  id: 'row-1', code: '', desc: 'Concrete', unit: 'm3', qty: 2, rate: 5, total: 10,
  type: 'unit', stdStatus: 'unmatched',
}

const boq: Boq = {
  id: 'boq-1', project: 'Project', vendor: 'Vendor', workType: 'Structural', date: '2026-07-15',
  totalItems: 1, grandTotal: 10, status: 'draft', stdStatus: 'none',
  sections: [{ header: 'Items', items: [item] }], createdAt: '', updatedAt: '',
}

test('quantity and rate edits recompute the normalized row total', () => {
  const quantityEdit = updateReviewItem([item], 0, 'qty', 3)
  assert.equal(quantityEdit[0].total, 15)
  const rateEdit = updateReviewItem(quantityEdit, 0, 'rate', 7)
  assert.equal(rateEdit[0].total, 21)
})

test('current edited metadata and items determine approval blockers', () => {
  const invalid = buildReviewVerification(boq, {
    vendor: '', project: 'Project', workType: 'Unclassified', date: '2026-07-15', items: [item],
  })
  assert.equal(invalid.hasBlockingIssues, true)
  assert.ok(invalid.issues.some((issue) => issue.message === 'vendor is required'))

  const editedItem = updateReviewItem([item], 0, 'rate', 6)[0]
  const valid = buildReviewVerification(boq, {
    vendor: 'Edited Vendor', project: 'Edited Project', workType: 'Structural',
    date: '2026-07-16', items: [editedItem],
  })
  assert.equal(valid.hasBlockingIssues, false)
})

test('fallback review keys stay stable when editable description and unit change', () => {
  const withoutId = { ...item, id: undefined }
  const before = reviewItemKey('boq-1', withoutId, 4)
  const after = reviewItemKey('boq-1', { ...withoutId, desc: 'Edited', unit: 'ton' }, 4)
  assert.equal(before, 'boq-1-4')
  assert.equal(after, before)
  assert.equal(reviewItemKey('boq-1', item, 4), 'row-1')
})
