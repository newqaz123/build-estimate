import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { normalizeEstimateItems, toEstimateItemPayload } from './page'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('estimate item normalization and save payload preserve catalog stdId', () => {
  const [item] = normalizeEstimateItems([
    {
      code: 'A-1',
      desc: 'Ready-mix concrete',
      unit: 'm³',
      qty: 2,
      rate: 100,
      total: 200,
      source: 'imported',
      stdId: 'std-1',
      stdSnapshot: { description: 'Ready-mix concrete', unit: 'm³' },
    },
  ])

  assert.equal(item?.stdId, 'std-1')
  assert.deepEqual(item?.stdSnapshot, { description: 'Ready-mix concrete', unit: 'm³' })
  assert.equal(toEstimateItemPayload(item!).stdId, 'std-1')
  assert.deepEqual(toEstimateItemPayload(item!).stdSnapshot, { description: 'Ready-mix concrete', unit: 'm³' })
})

test('catalog picker explains historical average seeding and no-history fallback', () => {
  assert.match(source, /Approved average/)
  assert.match(source, /No approved history · rate starts at ฿0/)
  assert.match(source, /standardEntryToEstimateAiCatalogEntry/)
  assert.match(source, /setModalRate\(String\(h\.historicalPricing\?\.average \?\? 0\)\)/)
})
