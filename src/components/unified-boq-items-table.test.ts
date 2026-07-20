import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoqInformationalItem, BoqPricedItem, BoqSection } from '@/lib/boq-schema'
import { buildUnifiedBoqSections } from '@/lib/boq-unified-rows'
import type { InlineCatalogRowState } from './use-inline-catalog-matching'
import { UnifiedBoqItemsTable } from './unified-boq-items-table'

const tableSource = readFileSync(new URL('./unified-boq-items-table.tsx', import.meta.url), 'utf8')

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

function bundleChild(overrides: Partial<BoqInformationalItem> = {}): BoqInformationalItem {
  return {
    id: 'bundle-child-1',
    desc: 'Informational bundle component',
    pricingRole: 'bundle_child',
    parentBundleId: 'bundle-parent-1',
    stdStatus: 'excluded',
    ...overrides,
  }
}

function renderTable(
  sections: BoqSection[],
  catalogState: (row: { item: BoqPricedItem }) => InlineCatalogRowState = () => ({ suggestion: null, busy: null, error: null }),
): string {
  const noopRow = () => undefined
  return renderToStaticMarkup(createElement(UnifiedBoqItemsTable, {
    sections: buildUnifiedBoqSections(sections),
    readOnly: false,
    disabled: false,
    catalogState,
    onFieldChange: () => undefined,
    onAcceptSuggestion: noopRow,
    onAiSuggest: noopRow,
    onDismissSuggestion: noopRow,
    onFindMatch: noopRow,
    onExclude: noopRow,
  }))
}

test('keeps rate visible in the canonical BOQ columns and removes legacy row details', () => {
  const html = renderTable([{ header: 'Valves', items: [item()] }])
  const headers = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((match) => match[1].replace(/<[^>]+>/g, ''))

  assert.deepEqual(headers, ['Description', 'Unit', 'Qty', 'Rate', 'Material', 'Labour', 'Total', 'Catalog'])
  assert.equal(headers.includes('Type'), false)
  assert.equal(headers.includes('Code'), false)
  assert.match(html, /aria-label="Rate for Valve installation, row 1"[^>]*min="0"[^>]*value="100"/)
  assert.doesNotMatch(html, /Row details|Aggregate rate|aria-label="Code|aria-label="Type/)
})

test('shows non-priced bundle children without matching or counting them twice', () => {
  let catalogLookups = 0
  const html = renderTable([{
    header: 'Bundle',
    items: [
      item({ id: 'bundle-parent-1', pricingRole: 'bundle_parent', desc: 'Priced bundle', total: 800 }),
      bundleChild(),
    ],
  }], () => {
    catalogLookups += 1
    return { suggestion: null, busy: null, error: null }
  })

  assert.match(html, /Informational bundle component/)
  assert.match(html, /Bundle component · included in the parent price/)
  assert.match(html, />Included</)
  assert.match(html, />Informational</)
  assert.equal(catalogLookups, 1)
})

test('keeps separate material and labour rows with independent quantity and unit inputs', () => {
  const html = renderTable([{
    header: 'Valve work',
    items: [
      item({ id: 'material', desc: 'Stub-end 6B', unit: 'Pcs', qty: 8, rate: 2808, total: 22464, costComponent: 'material' }),
      item({ id: 'labour', desc: 'Stub-end 6B', unit: 'Db', qty: 48, rate: 300, total: 14400, costComponent: 'labour' }),
    ],
  }])

  assert.match(html, /aria-label="Quantity for Stub-end 6B, row 1"[^>]*value="8"/)
  assert.match(html, /aria-label="Unit for Stub-end 6B, row 1"[^>]*value="Pcs"/)
  assert.match(html, /aria-label="Quantity for Stub-end 6B, row 2"[^>]*value="48"/)
  assert.match(html, /aria-label="Unit for Stub-end 6B, row 2"[^>]*value="Db"/)
})

test('keeps separate component rows independently priced with explicit identity and read-only rate evidence', () => {
  const html = renderTable([{
    header: 'Valve work',
    items: [
      item({ id: 'material', desc: 'Material only', rate: 2808, total: 22464, costComponent: 'material' }),
      item({ id: 'labour', desc: 'Labour only', rate: 300, total: 2400, costComponent: 'labour' }),
    ],
  }])

  assert.match(html, /aria-label="Rate for Material only, row 1"[^>]*value="2808"/)
  assert.match(html, /aria-label="Rate for Labour only, row 2"[^>]*value="300"/)
  assert.match(html, /Material component/)
  assert.match(html, /Labour component/)
  assert.match(html, /Material row rate[^<]*<\/span><strong>฿2,808<\/strong>/)
  assert.match(html, /Labour row rate[^<]*<\/span><strong>฿300<\/strong>/)
  assert.match(html, /data-component="material"[\s\S]*?Material row rate[\s\S]*?data-component="labour"[^>]*>[\s\S]*?Labour not provided/)
  assert.match(html, /data-component="material"[^>]*>[\s\S]*?Material not provided[\s\S]*?data-component="labour"[\s\S]*?Labour row rate/)
  assert.doesNotMatch(html, /aria-label="Material (?:rate|total)|aria-label="Labour (?:rate|total)/)
})

test('combined rows render shared source-cost evidence as compact read-only values', () => {
  const html = renderTable([{
    header: 'Combined work',
    items: [item({
      desc: 'Combined valve',
      rate: 3108,
      total: 24864,
      sourceCosts: {
        material: { present: true, qty: 8, unit: 'Pcs', rate: 2808, total: 22464 },
        labour: { present: true, qty: 8, unit: 'Pcs', rate: 300, total: 2400 },
      },
    })],
  }])

  assert.match(html, /aria-label="Rate for Combined valve, row 1"[^>]*value="3108"/)
  assert.match(html, /Material source rate[^<]*<\/span><strong>฿2,808<\/strong>/)
  assert.match(html, /Labour source rate[^<]*<\/span><strong>฿300<\/strong>/)
  assert.doesNotMatch(html, /aria-label="Material (?:rate|total)|aria-label="Labour (?:rate|total)/)
})

test('missing source component prices remain visibly unprovided and cannot be allocated', () => {
  const html = renderTable([{ header: 'Unknown split', items: [item({ desc: 'Allowance', sourceCosts: undefined })] }])

  assert.match(html, /Material not provided/)
  assert.match(html, /Labour not provided/)
  assert.doesNotMatch(html, />Allocate<|allocation editor|onAllocate\(/i)
  assert.doesNotMatch(tableSource, /onComponentChange|onAllocate|materialAllocation|labourAllocation/)
})

test('renders each section as one full-width row and catalog controls inline with every item', () => {
  const html = renderTable([{ header: 'ON-OFF VALVE INSTALLATION', items: [item({ desc: 'Loose flange' })] }])

  assert.match(html, /class="unified-boq-section-row"[\s\S]*?<td colSpan="8">ON-OFF VALVE INSTALLATION<\/td>/)
  assert.match(html, /data-od-id="inline-catalog-section:0:id:item-1"/)
  assert.match(html, />Unmatched</)
})

test('disables only an active catalog row while its suggestion request is in flight', () => {
  const html = renderTable([{ header: 'Valves', items: [item({ desc: 'Busy row', costComponent: 'material' }), item({ id: 'other', desc: 'Other row', costComponent: 'material' })] }], (row) => ({
    suggestion: null,
    busy: row.item.desc === 'Busy row' ? 'ai' : null,
    error: null,
  }))
  const busyDescription = html.match(/<input[^>]*aria-label="Description for Busy row, row 1"/)?.[0] ?? ''
  const busyRate = html.match(/<input[^>]*aria-label="Rate for Busy row, row 1"/)?.[0] ?? ''
  const otherDescription = html.match(/<input[^>]*aria-label="Description for Other row, row 2"/)?.[0] ?? ''

  assert.match(busyDescription, /\sdisabled=""/)
  assert.match(busyRate, /\sdisabled=""/)
  assert.doesNotMatch(otherDescription, /\sdisabled=""/)
})
