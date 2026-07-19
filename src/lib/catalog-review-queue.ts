import type { Boq, BoqItem } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'

export interface CatalogReviewItem {
  boqId: string
  boqProject: string
  boqVendor?: string
  boqStatus: Boq['status']
  sectionIndex: number
  id?: string
  code?: string
  desc: string
  unit: string
  stdStatus: BoqItem['stdStatus']
  stdMatch?: string
  stdId?: string
}

export function collectCatalogReviewItems(boqs: Boq[]): CatalogReviewItem[] {
  const items: CatalogReviewItem[] = []
  for (const boq of boqs) {
    if (boq.status === 'rejected') continue
    boq.sections.forEach((section, sectionIndex) => {
      section.items.forEach((item) => {
        if (!isPricedBoqItem(item)) return
        if (item.stdStatus !== 'pending' && item.stdStatus !== 'unmatched') return
        items.push({
          boqId: boq.id,
          boqProject: boq.project,
          boqVendor: boq.vendor,
          boqStatus: boq.status,
          sectionIndex,
          id: item.id,
          code: item.code,
          desc: item.desc,
          unit: item.unit,
          stdStatus: item.stdStatus,
          stdMatch: item.stdMatch,
          stdId: item.stdId,
        })
      })
    })
  }
  return items
}
