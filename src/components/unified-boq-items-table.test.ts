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
    onComponentChange: () => undefined,
    onAllocate: () => undefined,
    onAcceptSuggestion: noopRow,
    onAiSuggest: noopRow,
    onDismissSuggestion: noopRow,
    onFindMatch: noopRow,
    onExclude: noopRow,
  }))
}

test('keeps the unified BOQ columns while moving legacy fields into row details', () => {
  const html = renderTable([{ header: 'Valves', items: [item()] }])
  const headers = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((match) => match[1].replace(/<[^>]+>/g, ''))

  assert.deepEqual(headers, ['Description', 'Unit', 'Qty', 'Material', 'Labour', 'Total', 'Catalog'])
  assert.equal(headers.includes('Rate'), false)
  assert.equal(headers.includes('Type'), false)
  assert.equal(headers.includes('Code'), false)
  assert.doesNotMatch(html, /review-component-badge/)
})

test('legacy aggregate rows can edit code, type, and rate without inventing a component split', () => {
  const html = renderTable([{
    header: 'Legacy',
    items: [item({ code: 'LEG-01', costComponent: 'combined', sourceCosts: undefined })],
  }])

  assert.match(html, /Row details/)
  assert.match(html, /aria-label="Code for Valve installation, row 1"[^>]*value="LEG-01"/)
  assert.match(html, /aria-label="Type for Valve installation, row 1"/)
  assert.match(html, /aria-label="Aggregate rate for Valve installation, row 1"[^>]*min="0"[^>]*value="100"/)
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

test('renders component rates only in the applicable column for single-component rows', () => {
  const html = renderTable([{
    header: 'Valve work',
    items: [
      item({ id: 'material', desc: 'Material only', rate: 2808, total: 22464, costComponent: 'material' }),
      item({ id: 'labour', desc: 'Labour only', rate: 300, total: 2400, costComponent: 'labour' }),
    ],
  }])

  assert.match(html, /aria-label="Material rate for Material only"[^>]*value="2808"/)
  assert.match(html, /data-component="labour"[^>]*>—<\/td>/)
  assert.match(html, /data-component="material"[^>]*>—<\/td>/)
  assert.match(html, /aria-label="Labour rate for Labour only"[^>]*value="300"/)
})

test('combined rows render editable material and labour component inputs', () => {
  const html = renderTable([{
    header: 'Combined work',
    items: [item({
      desc: 'Combined valve',
      sourceCosts: {
        material: { present: true, qty: 8, unit: 'Pcs', rate: 2808, total: 22464 },
        labour: { present: true, qty: 48, unit: 'Db', rate: 300, total: 14400 },
      },
    })],
  }])

  assert.match(html, /aria-label="Material rate for Combined valve"[^>]*value="2808"/)
  assert.match(html, /aria-label="Labour rate for Combined valve"[^>]*value="300"/)
})

test('unknown component splits require explicit allocation and do not render inferred cost inputs', () => {
  const html = renderTable([{ header: 'Unknown split', items: [item({ desc: 'Allowance', sourceCosts: undefined })] }])

  assert.match(html, />Allocate</)
  assert.doesNotMatch(html, /aria-label="Material (?:rate|total) for Allowance"/)
  assert.doesNotMatch(html, /aria-label="Labour (?:rate|total) for Allowance"/)
  assert.match(tableSource, /onAllocate\(row, material, labour\)/)
})

test('renders each section as one full-width row and catalog controls inline with every item', () => {
  const html = renderTable([{ header: 'ON-OFF VALVE INSTALLATION', items: [item({ desc: 'Loose flange' })] }])

  assert.match(html, /class="unified-boq-section-row"[\s\S]*?<td colSpan="7">ON-OFF VALVE INSTALLATION<\/td>/)
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
  const busyMaterial = html.match(/<input[^>]*aria-label="Material rate for Busy row"/)?.[0] ?? ''
  const otherDescription = html.match(/<input[^>]*aria-label="Description for Other row, row 2"/)?.[0] ?? ''

  assert.match(busyDescription, /\sdisabled=""/)
  assert.match(busyMaterial, /\sdisabled=""/)
  assert.doesNotMatch(otherDescription, /\sdisabled=""/)
})
