import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import type { StandardEntry } from '@/lib/standard-schema'
import { CatalogConversionsPanel, conversionEffects, describeRule } from './catalog-conversions-panel'

const now = '2026-10-25T00:00:00.000Z'
const pipe: StandardEntry = {
  id: 'pipe', description: 'Steel pipe 1 inch', unit: 'm', aliases: [], sourceBoqCount: 2, createdAt: now, updatedAt: now,
  historicalPricing: {
    count: 2, min: 90, average: 95, max: 100,
    sources: [
      { boqId: 'a', project: 'p', vendor: 'v', date: '2026-10-01', section: 's', description: 'pipe', unit: 'm', rate: 100 },
      { boqId: 'b', project: 'p', vendor: 'v', date: '2026-10-02', section: 's', description: 'pipe', unit: 'm', rate: 90,
        converted: { unit: 'เส้น', rate: 360, ruleId: 'r1', catalogUnitsPerSourceUnit: 4 } },
    ],
  },
}

test('describes a rule in plain words', () => {
  assert.equal(describeRule({ sourceUnit: 'เส้น', catalogUnit: 'm', catalogUnitsPerSourceUnit: '4' }), '1 เส้น = 4 m')
})

test('shows which catalog items a rule changes and the new average', () => {
  assert.deepEqual(conversionEffects({ id: 'r1' }, [pipe]), [
    { standardId: 'pipe', description: 'Steel pipe 1 inch', unit: 'm', convertedCount: 1, totalCount: 2, average: 95 },
  ])
  assert.deepEqual(conversionEffects({ id: 'other' }, [pipe]), [])
})

test('the panel renders an add form with an all-items or one-item choice', () => {
  const html = renderToStaticMarkup(<CatalogConversionsPanel standards={[pipe]} onChanged={() => {}} />)
  assert.match(html, /Add a conversion/)
  assert.match(html, /All catalog items/)
  assert.match(html, /Only: Steel pipe 1 inch \(m\)/)
  assert.match(html, /Save conversion/)
})

test('the Catalog page has a Unit conversions tab and Compare explains converted rates', () => {
  const page = readFileSync(new URL('../app/(authenticated)/catalog/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /Unit conversions<\/button>/)
  assert.match(page, /<CatalogConversionsPanel standards=\{standards\} onChanged=\{fetchData\} \/>/)
  const table = readFileSync(new URL('./boq-catalog-component-table.tsx', import.meta.url), 'utf8')
  assert.match(table, /Compared as \{currency\(row\.conversion\.catalogRate\)\}/)
})
