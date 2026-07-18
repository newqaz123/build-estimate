import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from './boq-schema'
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
