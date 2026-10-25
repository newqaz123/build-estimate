import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { BoqCatalogComparisonRow } from './boq-catalog-comparison'
import { summarizeBoqWorkspace } from './boq-workspace-summary'
import { AWAITING_APPROVAL_LABEL, countAwaitingApproval, formatVsCatalog, isAwaitingApproval, vsCatalogPct } from './quote-numbers'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function row(rate: number | null, average: number | null, qty = 1, present = true): BoqCatalogComparisonRow {
  const component = { present, qty, unit: 'm', rate, total: rate === null ? null : rate * qty, benchmark: average === null ? null : { count: 1, min: average, average, max: average } }
  return { components: { material: component, labour: { ...component, present: false } } } as unknown as BoqCatalogComparisonRow
}

test('every status except approved or rejected waits for approval', () => {
  assert.equal(isAwaitingApproval({ status: 'draft' }), true)
  assert.equal(isAwaitingApproval({ status: 'review' }), true)
  assert.equal(isAwaitingApproval({ status: 'parsed' }), true)
  assert.equal(isAwaitingApproval({ status: 'rejected' }), false)
  assert.equal(isAwaitingApproval({ status: 'approved' }), false)
  const boqs = [{ status: 'draft' }, { status: 'approved' }, { status: 'review' }] as const
  assert.equal(countAwaitingApproval(boqs), 2)
  // The Dashboard summary is the same count.
  assert.equal(summarizeBoqWorkspace(boqs.map((b) => ({ ...b, totalItems: 1, vendor: 'A' }))).unapprovedCount, 2)
})

test('material vs catalog is quantity-weighted and skips rows without a catalog average', () => {
  assert.equal(vsCatalogPct([row(96, 100, 10), row(50, null), row(10, 10, 1, false)], 'material')?.toFixed(1), '-4.0')
  assert.equal(vsCatalogPct([row(110, 100, 1), row(100, 100, 3)], 'material')?.toFixed(1), '2.5')
  assert.equal(vsCatalogPct([], 'material'), null)
  assert.equal(formatVsCatalog(-4), '−4.0%')
  assert.equal(formatVsCatalog(2.5), '+2.5%')
  assert.equal(formatVsCatalog(0.01), 'At average')
  assert.equal(formatVsCatalog(null), '—')
})

test('Dashboard, Comparison Inbox and the BOQ comparison all use the shared helpers', () => {
  const compare = read('../app/(authenticated)/compare/page.tsx')
  const dashboard = read('../app/(authenticated)/dashboard/page.tsx')
  const panel = read('../components/boq-catalog-comparison-panel.tsx')
  const table = read('../components/boq-catalog-component-table.tsx')
  const summary = read('./boq-workspace-summary.ts')
  assert.match(compare, /countAwaitingApproval\(boqs\)/)
  assert.match(compare, /\{AWAITING_APPROVAL_LABEL\}/)
  assert.match(dashboard, /\{AWAITING_APPROVAL_LABEL\}/)
  assert.match(summary, /countAwaitingApproval\(boqs\)/)
  assert.match(table, /vsCatalogPct\(rows, 'material'\)/)
  assert.match(compare, /formatVsCatalog\(/)
  assert.match(panel, /formatVsCatalog\(/)
  for (const source of [compare, dashboard, panel, table]) {
    assert.doesNotMatch(source, /function (formatVariance|weightedVariance)\(/)
  }
  assert.equal(AWAITING_APPROVAL_LABEL, 'Not approved yet')
})
