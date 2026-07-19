import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildReviewFingerprint,
  buildReviewVerification,
  reviewItemKey,
  updateReviewItem,
} from './boq-review-state'
import type { Boq, BoqItem, BoqPricedItem } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'

const item: BoqPricedItem = {
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
  assert.ok(isPricedBoqItem(quantityEdit[0]))
  assert.equal(quantityEdit[0].total, 15)
  const rateEdit = updateReviewItem(quantityEdit, 0, 'rate', 7)
  assert.ok(isPricedBoqItem(rateEdit[0]))
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

test('suspicious zero values remain visible warnings without blocking approval', () => {
  const result = buildReviewVerification(boq, {
    vendor: 'Vendor', project: 'Project', workType: 'Structural', date: '2026-07-15',
    items: [{ ...item, qty: 0, total: 0 }],
  })
  assert.equal(result.hasBlockingIssues, false)
  assert.ok(result.issues.some((issue) => issue.severity === 'warning' && issue.message === 'qty is suspiciously zero'))
})

test('LLM verification fingerprint changes whenever reviewed metadata or items change', () => {
  const edits = {
    vendor: 'Vendor', project: 'Project', workType: 'Structural' as const,
    date: '2026-07-15', items: [item],
  }
  const original = buildReviewFingerprint(edits)
  assert.notEqual(buildReviewFingerprint({ ...edits, vendor: 'Edited' }), original)
  assert.notEqual(buildReviewFingerprint({ ...edits, items: [{ ...item, rate: 6, total: 12 }] }), original)
})

test('review keeps informational bundle children read-only and excludes them from verification totals', () => {
  const child: BoqItem = {
    id: 'bundle-child',
    pricingRole: 'bundle_child',
    parentBundleId: 'row-1',
    desc: 'Pump body',
    stdStatus: 'pending',
  }

  assert.deepEqual(updateReviewItem([child], 0, 'qty', 99), [child])
  const result = buildReviewVerification({ ...boq, sourceTotal: 10 }, {
    vendor: 'Vendor',
    project: 'Project',
    workType: 'Structural',
    date: '2026-07-15',
    items: [item, child],
  })
  assert.equal(result.hasBlockingIssues, false)
  assert.equal(result.issues.some((issue) => issue.code === 'invalid_number'), false)
})
