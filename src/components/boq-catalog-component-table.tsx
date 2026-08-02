import type { ReactNode } from 'react'

import {
  formatHistoricalVariance,
  type BoqCatalogComparisonRow,
} from '@/lib/boq-catalog-comparison'

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

function weightedVariance(
  rows: BoqCatalogComparisonRow[],
  key: ComponentKey,
): number | null {
  let actual = 0
  let baseline = 0

  for (const row of rows) {
    const component = row.components[key]
    if (
      !component.present
      || component.qty === null
      || component.rate === null
      || component.benchmark === null
      || component.qty <= 0
      || component.benchmark.average <= 0
    ) {
      continue
    }

    actual += component.rate * component.qty
    baseline += component.benchmark.average * component.qty
  }

  return baseline > 0
    ? ((actual - baseline) / baseline) * 100
    : null
}

export function summarizeComponentComparison(
  rows: BoqCatalogComparisonRow[],
  boqTotal: number,
): ComponentComparisonSummary {
  return {
    materialVariancePct: weightedVariance(rows, 'material'),
    labourVariancePct: weightedVariance(rows, 'labour'),
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

function matchButton(
  row: BoqCatalogComparisonRow,
  onMatch: (row: BoqCatalogComparisonRow) => void,
) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      data-od-id="compare-component-match"
      onClick={() => onMatch(row)}
    >
      {row.item.stdId ? 'Change match' : 'Match'}
    </button>
  )
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
    </div>
  )
}

function renderComponentSubRow(
  row: BoqCatalogComparisonRow,
  key: ComponentKey,
  showLineCells: boolean,
  groupSize: number,
  onMatch: (row: BoqCatalogComparisonRow) => void,
): ReactNode {
  const component = row.components[key]

  if (!component.present) {
    return (
      <tr key={key} className="compare-component-row compare-component-row-missing" data-component={key}>
        {showLineCells ? <td className="compare-component-line-cell" rowSpan={groupSize}>{lineDescription(row)}</td> : null}
        <td data-label="Component">
          <span className="compare-component-tag compare-component-tag-missing">
            {COMPONENT_LABELS[key]}
          </span>
        </td>
        <td data-label="Component data" colSpan={5}>
          — not in source quotation
        </td>
        {showLineCells ? <td className="compare-component-action-cell" rowSpan={groupSize}>{matchButton(row, onMatch)}</td> : null}
      </tr>
    )
  }

  const qty = component.qty ?? 0
  const rate = component.rate ?? 0
  const noHistory = component.benchmark === null

  return (
    <tr key={key} className="compare-component-row" data-component={key}>
      {showLineCells ? <td className="compare-component-line-cell" rowSpan={groupSize}>{lineDescription(row)}</td> : null}
      <td data-label="Component">
        <span className="compare-component-tag">{COMPONENT_LABELS[key]}</span>
      </td>
      <td data-label="Qty" className="num">{qty}</td>
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
      {showLineCells ? <td className="compare-component-action-cell" rowSpan={groupSize}>{matchButton(row, onMatch)}</td> : null}
    </tr>
  )
}

function renderTotalOnlyRow(
  row: BoqCatalogComparisonRow,
  onMatch: (row: BoqCatalogComparisonRow) => void,
): ReactNode {
  const lumpSum = row.item.type === 'lump_sum'
  const tag = lumpSum ? 'Lump sum' : 'Combined'
  const tagClass = lumpSum
    ? 'compare-component-tag compare-component-tag-lump-sum'
    : 'compare-component-tag compare-component-tag-combined'
  const noHistory = row.benchmark === null

  return (
    <tr className="compare-component-row compare-component-row-total-only">
      <td className="compare-component-line-cell">{lineDescription(row)}</td>
      <td data-label="Component">
        <span className={tagClass}>{tag}</span>
        <small className="compare-component-note">
          No material/labour split in source — compared on total only.
        </small>
      </td>
      <td data-label="Qty" className="num">{row.item.qty}</td>
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
      <td className="compare-component-action-cell">{matchButton(row, onMatch)}</td>
    </tr>
  )
}

function renderRowGroup(
  row: BoqCatalogComparisonRow,
  onMatch: (row: BoqCatalogComparisonRow) => void,
): ReactNode {
  if (isTotalOnlyRow(row)) {
    return (
      <tbody className="compare-component-group compare-component-group-total-only" key={row.key}>
        {renderTotalOnlyRow(row, onMatch)}
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
        onMatch,
      ))}
      <tr className="compare-component-line-total" aria-hidden="true">
        <td data-label="Line total" className="compare-component-line-total-cell num" colSpan={8}>
          Line total {currency(row.item.total)}
        </td>
      </tr>
    </tbody>
  )
}

export function BoqCatalogComponentTable(props: {
  rows: BoqCatalogComparisonRow[]
  onMatch: (row: BoqCatalogComparisonRow) => void
}): ReactNode {
  const { rows, onMatch } = props

  return (
    <div
      className="compare-component-table-wrap"
      data-od-id="compare-component-table"
      role="region"
      aria-label="One BOQ versus the Standard Catalog — horizontally scrollable"
      tabIndex={0}
    >
      <div className="table-scroll-hint" aria-hidden="true">Scroll horizontally for component rate benchmark details</div>
      <table className="data-table compare-component-table" aria-label="One BOQ versus the Standard Catalog">
        <thead>
          <tr>
            <th>BOQ item</th>
            <th>Component</th>
            <th className="num-col">Qty</th>
            <th>Unit</th>
            <th className="num-col">BOQ rate</th>
            <th className="num-col">Catalog average</th>
            <th>Variance</th>
            <th className="text-right">Action</th>
          </tr>
        </thead>
        {rows.map((row) => renderRowGroup(row, onMatch))}
      </table>
    </div>
  )
}
