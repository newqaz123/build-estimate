import { verifyBoqLocally, type VerificationResult } from './boq-ingestion'
import type { Boq, BoqItem, WorkType } from './boq-schema'
import { calculateBoqTotals, isPricedBoqItem } from './boq-pricing'

export type ReviewItemField = 'desc' | 'unit' | 'qty' | 'rate'

export interface ReviewEdits {
  vendor: string
  project: string
  workType: WorkType
  date: string
  items: BoqItem[]
}

export function buildReviewFingerprint(edits: ReviewEdits): string {
  return JSON.stringify({
    vendor: edits.vendor,
    project: edits.project,
    workType: edits.workType,
    date: edits.date,
    items: edits.items,
  })
}

export function buildCanonicalRevisionKey(boq: Pick<Boq, 'vendor' | 'project' | 'workType' | 'date' | 'sections' | 'updatedAt'>): string {
  return JSON.stringify({
    vendor: boq.vendor,
    project: boq.project,
    workType: boq.workType,
    date: boq.date,
    sections: boq.sections,
    updatedAt: boq.updatedAt,
  })
}

export function updateReviewItem(
  items: BoqItem[],
  index: number,
  field: ReviewItemField,
  value: string | number,
): BoqItem[] {
  return items.map((item, itemIndex) => {
    if (itemIndex !== index) return item
    if (!isPricedBoqItem(item) && field !== 'desc') return item
    const updated = { ...item, [field]: value }
    if (isPricedBoqItem(updated) && (field === 'qty' || field === 'rate')) {
      updated.total = updated.qty * updated.rate
    }
    return updated
  })
}

export function buildReviewVerification(boq: Boq, edits: ReviewEdits): VerificationResult {
  const pricedItems = edits.items.filter(isPricedBoqItem)
  const { grandTotal } = calculateBoqTotals([{ header: 'Parsed Items', items: edits.items }])
  return verifyBoqLocally({
    vendor: edits.vendor,
    project: edits.project,
    workType: edits.workType,
    date: edits.date,
    sections: [{ header: 'Parsed Items', items: pricedItems }],
    grandTotal,
    sourceTotal: boq.sourceTotal,
    ...(boq.sourceQuoteSummary ? { sourceQuoteSummary: boq.sourceQuoteSummary } : {}),
  })
}

export function reviewItemKey(boqId: string, item: BoqItem, index: number): string {
  return item.id ?? `${boqId}-${index}`
}
