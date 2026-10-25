/**
 * The one place that defines the headline numbers shown on more than one page
 * (Dashboard, Comparison Inbox, BOQ comparison). Pages must use these helpers
 * instead of counting or formatting on their own, so the same data always
 * shows the same number.
 */
import type { BoqCatalogComparisonRow } from './boq-catalog-comparison'
import type { Boq } from './boq-schema'

/** Label for the count of quotes that still need the user's Approve. */
export const AWAITING_APPROVAL_LABEL = 'Not approved yet'

/** A quote waits for approval until the user approves (or rejects) it. */
export function isAwaitingApproval(boq: Pick<Boq, 'status'>): boolean {
  return boq.status !== 'approved' && boq.status !== 'rejected'
}

export function countAwaitingApproval(boqs: ReadonlyArray<Pick<Boq, 'status'>>): number {
  let count = 0
  for (const boq of boqs) if (isAwaitingApproval(boq)) count += 1
  return count
}

export type VsCatalogComponent = 'material' | 'labour'

/**
 * Quantity-weighted % difference between the quote's rates and the catalog
 * average for one component, over rows that have both. null when nothing compares.
 */
export function vsCatalogPct(rows: readonly BoqCatalogComparisonRow[], key: VsCatalogComponent): number | null {
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
    ) continue
    actual += component.rate * component.qty
    baseline += component.benchmark.average * component.qty
  }
  return baseline > 0 ? ((actual - baseline) / baseline) * 100 : null
}

/** "+4.0%", "−4.0%", "At average" (within ±0.05%), or "—" when nothing compares. */
export function formatVsCatalog(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.05) return 'At average'
  const sign = value > 0 ? '+' : '−'
  return `${sign}${Math.abs(value).toFixed(1)}%`
}
