import type { ReactNode } from 'react'

import {
  formatHistoricalVariance,
  type BoqCatalogComparisonRow,
} from '@/lib/boq-catalog-comparison'
import { vsCatalogPct } from '@/lib/quote-numbers'

export interface ComponentComparisonSummary {
  materialVariancePct: number | null
  labourVariancePct: number | null
  componentLines: number
  totalLines: number
  boqTotal: number
}

const COMPONENT_KEYS = ['material', 'labour'] as const
type ComponentKey = (typeof COMPONENT_KEYS)[number]

const COMPONENT_LABELS: Record<ComponentKey, string> = {
  material: 'Material',
  labour: 'Labour',
}

type BenchmarkSummary = {
  count: number
  min: number
  average: number
  max: number
} | null

function currency(value: number): string {
  return `฿${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

export function summarizeComponentComparison(
  rows: BoqCatalogComparisonRow[],
  boqTotal: number,
): ComponentComparisonSummary {
  return {
    materialVariancePct: vsCatalogPct(rows, 'material'),
    labourVariancePct: vsCatalogPct(rows, 'labour'),
    componentLines: rows.filter((row) =>
      row.components.material.present
      || row.components.labour.present,
    ).length,
    totalLines: rows.length,
    boqTotal,
  }
}

function varianceClass(value: number | null, totalOnly = false): string {
  if (totalOnly) return 'compare-component-variance-total'
  if (value === null) return 'compare-component-variance-new'
  if (Math.abs(value) < 0.05) return 'compare-component-variance-at'
  return value > 0
    ? 'compare-component-variance-above'
    : 'compare-component-variance-below'
}

function displayComponents(row: BoqCatalogComparisonRow): ComponentKey[] {
  const present = COMPONENT_KEYS.filter(
    (key) => row.components[key].present,
  )

  return present.length === 1 ? [...COMPONENT_KEYS] : present
}

function isTotalOnlyRow(row: BoqCatalogComparisonRow): boolean {
  return row.item.type === 'lump_sum'
    || (!row.components.material.present && !row.components.labour.present)
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function compositionPercentage(
  componentTotal: number | null | undefined,
  lineTotal: number,
): number | null {
  if (!isFinitePositive(componentTotal) || !isFinitePositive(lineTotal)) return null
  const pct = (componentTotal / lineTotal) * 100
  return Number.isFinite(pct) ? pct : null
}

function formatCompositionPct(value: number): string {
  return `${value.toFixed(1)}%`
}

function lineTotalFooterLabel(row: BoqCatalogComparisonRow): string {
  const lineTotal = row.item.total
  const parts = [`Line total ${currency(lineTotal)}`]
  const materialPct = compositionPercentage(row.components.material.total, lineTotal)
  const labourPct = compositionPercentage(row.components.labour.total, lineTotal)
  if (materialPct !== null) parts.push(`Material ${formatCompositionPct(materialPct)}`)
  if (labourPct !== null) parts.push(`Labour ${formatCompositionPct(labourPct)}`)
  return parts.join(' · ')
}

function benchmarkSummary(benchmark: BenchmarkSummary): ReactNode {
  if (!benchmark) {
    return (
      <span className="compare-component-no-history">No prior approved rates</span>
    )
  }

  return (
    <span className="compare-component-benchmark">
      <strong className="num">{currency(benchmark.average)}</strong>
      <small className="compare-component-benchmark-range num">
        {currency(benchmark.min)}–{currency(benchmark.max)} · {benchmark.count} approved {benchmark.count === 1 ? 'rate' : 'rates'}
      </small>
    </span>
  )
}

function formatFactor(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
}

function lineDescription(row: BoqCatalogComparisonRow): ReactNode {
  return (
    <div className="compare-component-line-desc">
      <strong>{row.item.desc}</strong>
      <small className="compare-component-section">{row.section}</small>
      {row.candidate ? (
        <small className="compare-component-catalog">{row.candidate.description} · {row.candidate.unit}</small>
      ) : (
        <small className="compare-component-catalog compare-component-catalog-none">No safe candidate</small>
      )}
      {row.conversion ? (
        <small className="compare-component-conversion" data-od-id="compare-unit-conversion">
          Compared as {currency(row.conversion.catalogRate)} per {row.conversion.catalogUnit} (1 {row.conversion.sourceUnit} = {formatFactor(row.conversion.catalogUnitsPerSourceUnit)} {row.conversion.catalogUnit})
        </small>
      ) : null}
    </div>
  )
}

function renderComponentSubRow(
  row: BoqCatalogComparisonRow,
  key: ComponentKey,
  showLineCells: boolean,
  groupSize: number,
): ReactNode {
  const component = row.components[key]

  if (!component.present) {
    return (
      <tr key={key} className="compare-component-row compare-component-row-missing" data-component={key}>
        {showLineCells ? <td data-label="BOQ item" className="compare-component-item compare-component-line-cell" rowSpan={groupSize}>{lineDescription(row)}</td> : null}
        <td data-label="Component">
          <span className={`compare-component-tag compare-component-tag-${key} compare-component-tag-missing`}>
            {COMPONENT_LABELS[key]}
          </span>
        </td>
        <td data-label="Component data" colSpan={5}>
          — not in source quotation
        </td>
      </tr>
    )
  }

  const qty = component.qty ?? 0
  const rate = component.rate ?? 0
  const noHistory = component.benchmark === null

  return (
    <tr key={key} className="compare-component-row" data-component={key}>
      {showLineCells ? <td data-label="BOQ item" className="compare-component-item compare-component-line-cell" rowSpan={groupSize}>{lineDescription(row)}</td> : null}
      <td data-label="Component">
        <span className={`compare-component-tag compare-component-tag-${key}`}>{COMPONENT_LABELS[key]}</span>
      </td>
      <td data-label="Quantity" className="num">{qty}</td>
      <td data-label="Unit">{component.unit}</td>
      <td data-label="BOQ rate" className="num">{currency(rate)}</td>
      {noHistory ? (
        <td data-label="Catalog average · Variance" className="num" colSpan={2}>
          {benchmarkSummary(component.benchmark)}
        </td>
      ) : (
        <>
          <td data-label="Catalog average" className="num">{benchmarkSummary(component.benchmark)}</td>
          <td data-label="Variance" className={varianceClass(component.variancePct)}>
            {formatHistoricalVariance(component.variancePct)}
          </td>
        </>
      )}
    </tr>
  )
}

function renderTotalOnlyRow(row: BoqCatalogComparisonRow): ReactNode {
  const lumpSum = row.item.type === 'lump_sum'
  const tag = lumpSum ? 'Lump sum' : 'Combined'
  const tagClass = lumpSum
    ? 'compare-component-tag compare-component-tag-lump compare-component-tag-lump-sum'
    : 'compare-component-tag compare-component-tag-combined'
  const noHistory = row.benchmark === null

  return (
    <tr className="compare-component-row compare-component-row-total-only">
      <td data-label="BOQ item" className="compare-component-item compare-component-line-cell">{lineDescription(row)}</td>
      <td data-label="Component">
        <span className={tagClass}>{tag}</span>
        <small className="compare-component-note">
          No material/labour split in source — compared on total only.
        </small>
      </td>
      <td data-label="Quantity" className="num">{row.item.qty}</td>
      <td data-label="Unit">{row.item.unit}</td>
      <td data-label="BOQ rate" className="num">{currency(row.item.rate)}</td>
      {noHistory ? (
        <td data-label="Catalog average · Variance" className="num" colSpan={2}>
          {benchmarkSummary(row.benchmark)}
        </td>
      ) : (
        <>
          <td data-label="Catalog average" className="num">{benchmarkSummary(row.benchmark)}</td>
          <td data-label="Variance" className={varianceClass(row.variancePct, true)}>
            {formatHistoricalVariance(row.variancePct)}
          </td>
        </>
      )}
    </tr>
  )
}

function renderRowGroup(row: BoqCatalogComparisonRow): ReactNode {
  if (isTotalOnlyRow(row)) {
    return (
      <tbody className="compare-component-group compare-component-group-total-only" key={row.key}>
        {renderTotalOnlyRow(row)}
        <tr className="compare-component-total-row compare-component-line-total" aria-hidden="true">
          <td data-label="Line total" className="compare-component-line-total-cell num" colSpan={7}>
            {lineTotalFooterLabel(row)}
          </td>
        </tr>
      </tbody>
    )
  }

  const keys = displayComponents(row)
  const groupSize = keys.length

  return (
    <tbody className="compare-component-group" key={row.key}>
      {keys.map((key, index) => renderComponentSubRow(
        row,
        key,
        index === 0,
        groupSize,
      ))}
      <tr className="compare-component-total-row compare-component-line-total" aria-hidden="true">
        <td data-label="Line total" className="compare-component-line-total-cell num" colSpan={7}>
          {lineTotalFooterLabel(row)}
        </td>
      </tr>
    </tbody>
  )
}

export function BoqCatalogComponentTable(props: {
  rows: BoqCatalogComparisonRow[]
}): ReactNode {
  const { rows } = props

  return (
    <div
      className="data-table-wrap compare-component-table-wrap"
      data-od-id="compare-component-table"
      role="region"
      aria-label="BOQ material and labour comparison — horizontally scrollable"
      tabIndex={0}
    >
      <div className="table-scroll-hint" aria-hidden="true">Scroll horizontally for component rate benchmark details</div>
      <table className="data-table compare-component-table" aria-label="BOQ material and labour comparison">
        <thead>
          <tr>
            <th>BOQ item</th>
            <th>Component</th>
            <th className="num-col">Qty</th>
            <th>Unit</th>
            <th className="num-col">BOQ rate</th>
            <th className="num-col">Catalog average</th>
            <th>Variance</th>
          </tr>
        </thead>
        {rows.map((row) => renderRowGroup(row))}
      </table>
    </div>
  )
}
