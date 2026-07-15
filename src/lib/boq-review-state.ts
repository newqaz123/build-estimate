import { verifyBoqLocally, type VerificationResult } from './boq-ingestion'
import type { Boq, BoqItem, WorkType } from './boq-schema'

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

export function updateReviewItem(
  items: BoqItem[],
  index: number,
  field: ReviewItemField,
  value: string | number,
): BoqItem[] {
  return items.map((item, itemIndex) => {
    if (itemIndex !== index) return item
    const updated = { ...item, [field]: value }
    if (field === 'qty' || field === 'rate') updated.total = updated.qty * updated.rate
    return updated
  })
}

export function buildReviewVerification(boq: Boq, edits: ReviewEdits): VerificationResult {
  const grandTotal = edits.items.reduce((sum, item) => sum + item.total, 0)
  return verifyBoqLocally({
    vendor: edits.vendor,
    project: edits.project,
    workType: edits.workType,
    date: edits.date,
    sections: [{ header: 'Parsed Items', items: edits.items }],
    grandTotal,
    sourceTotal: boq.sourceTotal,
  })
}

export function reviewItemKey(boqId: string, item: BoqItem, index: number): string {
  return item.id ?? `${boqId}-${index}`
}
