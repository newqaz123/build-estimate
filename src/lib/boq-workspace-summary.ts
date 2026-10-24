import type { Boq } from './boq-schema'

export interface BoqWorkspaceSummary {
  /** Line items across every quote, not just the page being shown. */
  totalItems: number
  /** Distinct vendor names on quotes, ignoring case, spacing, and blank or unknown vendors. */
  vendorCount: number
  /** Quotes not yet approved. */
  unapprovedCount: number
}

const UNKNOWN_VENDOR = /^unknown(\s+vendor)?$/

function vendorKey(vendor: unknown): string | null {
  if (typeof vendor !== 'string') return null
  const key = vendor.trim().replace(/\s+/g, ' ').toLowerCase()
  return key && !UNKNOWN_VENDOR.test(key) ? key : null
}

export function summarizeBoqWorkspace(
  boqs: ReadonlyArray<Pick<Boq, 'totalItems' | 'vendor' | 'status'>>,
): BoqWorkspaceSummary {
  let totalItems = 0
  let unapprovedCount = 0
  const vendors = new Set<string>()
  for (const boq of boqs) {
    if (typeof boq.totalItems === 'number' && Number.isFinite(boq.totalItems) && boq.totalItems > 0) {
      totalItems += boq.totalItems
    }
    const key = vendorKey(boq.vendor)
    if (key) vendors.add(key)
    if (boq.status !== 'approved') unapprovedCount += 1
  }
  return { totalItems, vendorCount: vendors.size, unapprovedCount }
}
