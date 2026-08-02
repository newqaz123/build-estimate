import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  BoqCatalogComparisonRow,
  ComponentComparison,
} from '@/lib/boq-catalog-comparison'
import {
  BoqCatalogComponentTable,
  summarizeComponentComparison,
} from './boq-catalog-component-table'

function component(
  overrides: Partial<ComponentComparison> = {},
): ComponentComparison {
  return {
    present: true,
    unit: 'Pcs',
    qty: 8,
    rate: 2808,
    total: 22464,
    basis: 'native',
    benchmark: {
      unit: 'pcs',
      count: 14,
      min: 2600,
      average: 2750,
      max: 2950,
    },
    variancePct: ((2808 - 2750) / 2750) * 100,
    ...overrides,
  }
}

function row(
  overrides: Partial<BoqCatalogComparisonRow> = {},
): BoqCatalogComparisonRow {
  return {
    key: '0-item',
    sectionIndex: 0,
    section: 'E&M',
    item: {
      id: 'item',
      desc: 'STUB-END 6B BS4',
      unit: 'Lot',
      qty: 1,
      rate: 36864,
      total: 36864,
      type: 'unit',
      stdStatus: 'matched',
      stdId: 'std-1',
    },
    identity: { itemId: 'item' },
    candidate: {
      standardId: 'std-1',
      description: 'STUB-END 6B BS4',
      unit: 'Lot',
      score: 2000,
      matchReason: 'linked',
    },
    benchmark: null,
    variancePct: null,
    components: {
      material: component(),
      labour: component({
        unit: 'Db',
        qty: 48,
        rate: 300,
        total: 14400,
        benchmark: {
          unit: 'db',
          count: 11,
          min: 270,
          average: 285,
          max: 310,
        },
        variancePct: ((300 - 285) / 285) * 100,
      }),
    },
    ...overrides,
  }
}

function renderTable(rows: BoqCatalogComparisonRow[]): string {
  return renderToStaticMarkup(createElement(
    BoqCatalogComponentTable,
    {
      rows,
      onMatch: () => undefined,
    },
  ))
}

function matchControlCount(html: string): number {
  return (html.match(/data-od-id="compare-component-match"/g) ?? []).length
}

function groupBodies(html: string): string[] {
  return html.match(/<tbody\b[^>]*class="[^"]*compare-component-group[^"]*"[^>]*>[\s\S]*?<\/tbody>/g) ?? []
}

function assertOneMatchPerGroup(html: string, expectedGroups: number) {
  const groups = groupBodies(html)
  assert.equal(groups.length, expectedGroups, `expected ${expectedGroups} component groups`)
  assert.equal(matchControlCount(html), expectedGroups, 'one Match control per BOQ line group')
  for (const [index, body] of groups.entries()) {
    assert.equal(
      matchControlCount(body),
      1,
      `group ${index} must render exactly one Match/Change match control`,
    )
  }
}

test('summary weights component variance by benchmark cost exposure', () => {
  const summary = summarizeComponentComparison([row()], 36864)

  assert.equal(
    summary.materialVariancePct,
    ((2808 * 8 - 2750 * 8) / (2750 * 8)) * 100,
  )
  assert.equal(
    summary.labourVariancePct,
    ((300 * 48 - 285 * 48) / (285 * 48)) * 100,
  )
  assert.equal(summary.componentLines, 1)
  assert.equal(summary.totalLines, 1)
  assert.equal(summary.boqTotal, 36864)
})

test('renders independent material and labour sub-rows', () => {
  const html = renderTable([row()])

  assert.match(html, /STUB-END 6B BS4/)
  assert.match(html, /Material/)
  assert.match(html, /8/)
  assert.match(html, /Pcs/)
  assert.match(html, /฿2,808/)
  assert.match(html, /Labour/)
  assert.match(html, /48/)
  assert.match(html, /Db/)
  assert.match(html, /฿300/)
  assert.match(html, /14 approved rates/)
  assert.match(html, /Change match/)
  assert.match(html, /aria-label="BOQ material and labour comparison"/)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /data-label="Catalog average"/)
  assert.match(html, /data-label="Quantity"/)
  assert.match(html, /data-label="Variance"/)
  assert.match(html, /data-label="BOQ item"/)
  assert.match(html, /data-label="Action"/)
  assertOneMatchPerGroup(html, 1)
})

test('renders material and labour as separate grouped sub-rows', () => {
  const html = renderTable([row()])

  assert.match(html, /<tr[^>]*data-component="material"/)
  assert.match(html, /<tr[^>]*data-component="labour"/)

  const materialRow = html.match(/<tr[^>]*data-component="material"[^>]*>[\s\S]*?<\/tr>/)
  const labourRow = html.match(/<tr[^>]*data-component="labour"[^>]*>[\s\S]*?<\/tr>/)
  assert.ok(materialRow, 'material sub-row exists')
  assert.ok(labourRow, 'labour sub-row exists')
  assert.match(materialRow[0], /Pcs/)
  assert.match(materialRow[0], /฿2,808/)
  assert.doesNotMatch(materialRow[0], /Db/)
  assert.match(labourRow[0], /Db/)
  assert.match(labourRow[0], /฿300/)
  assert.doesNotMatch(labourRow[0], /Pcs/)

  assert.match(materialRow[0], /data-label="Component"/)
  assert.match(materialRow[0], /data-label="Quantity"/)
  assert.match(materialRow[0], /data-label="Catalog average"/)
  assert.match(materialRow[0], /data-label="Variance"/)
  assert.match(labourRow[0], /data-label="Component"/)
  assert.match(labourRow[0], /data-label="Quantity"/)
  assert.doesNotMatch(labourRow[0], /data-label="BOQ item"/)
  assert.doesNotMatch(labourRow[0], /data-label="Action"/)
  assertOneMatchPerGroup(html, 1)
})

test('renders absent, no-history, and lump-sum states explicitly', () => {
  const materialOnly = row({
    key: 'material-only',
    components: {
      material: component({ benchmark: null, variancePct: null }),
      labour: component({
        present: false,
        unit: '',
        qty: null,
        rate: null,
        total: null,
        basis: 'none',
        benchmark: null,
        variancePct: null,
      }),
    },
  })

  const lumpSum = row({
    key: 'lump',
    item: {
      ...row().item,
      desc: 'TOOLS AND CONSUMABLE',
      type: 'lump_sum',
      qty: 1,
      unit: 'Lot',
      rate: 6000,
      total: 6000,
      stdId: undefined,
      stdStatus: 'unmatched',
    },
    candidate: null,
    benchmark: {
      count: 9,
      min: 5000,
      average: 5800,
      max: 6500,
    },
    variancePct: ((6000 - 5800) / 5800) * 100,
    components: {
      material: component({
        present: false,
        unit: '',
        qty: null,
        rate: null,
        total: null,
        basis: 'none',
        benchmark: null,
        variancePct: null,
      }),
      labour: component({
        present: false,
        unit: '',
        qty: null,
        rate: null,
        total: null,
        basis: 'none',
        benchmark: null,
        variancePct: null,
      }),
    },
  })

  const html = renderTable([materialOnly, lumpSum])

  assert.match(html, /not in source quotation/)
  assert.match(html, /No prior approved rates/)
  assert.match(html, /Lump sum/)
  assert.match(html, /compared on total only/)

  const groups = groupBodies(html)
  assert.equal(groups.length, 2)

  const missingGroup = groups.find((body) => /not in source quotation/.test(body))
  const lumpGroup = groups.find((body) => /Lump sum/.test(body))
  assert.ok(missingGroup, 'missing/no-history group present')
  assert.ok(lumpGroup, 'lump-sum group present')

  assert.match(missingGroup!, /data-label="BOQ item"/)
  assert.match(missingGroup!, /data-label="Component"/)
  assert.match(missingGroup!, /data-label="Component data"/)
  assert.match(missingGroup!, /data-label="Catalog average · Variance"/)
  assert.match(missingGroup!, /data-label="Quantity"/)
  assert.match(missingGroup!, /data-label="Action"/)
  assert.match(missingGroup!, /data-label="Line total"/)

  assert.match(lumpGroup!, /data-label="BOQ item"/)
  assert.match(lumpGroup!, /data-label="Component"/)
  assert.match(lumpGroup!, /data-label="Quantity"/)
  assert.match(lumpGroup!, /data-label="Unit"/)
  assert.match(lumpGroup!, /data-label="BOQ rate"/)
  assert.match(lumpGroup!, /data-label="Catalog average"/)
  assert.match(lumpGroup!, /data-label="Variance"/)
  assert.match(lumpGroup!, /data-label="Action"/)
  assert.match(lumpGroup!, /data-label="Line total"/)
  assert.match(lumpGroup!, />Match</)

  assertOneMatchPerGroup(html, 2)
})
