import type { Boq, BoqItem } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'

export interface CatalogReadinessIssue {
  sectionIndex: number
  itemId?: string
  itemCode?: string
  description: string
  reason: string
}

export interface BoqCatalogReadiness {
  total: number
  resolved: number
  blocking: number
  items: CatalogReadinessIssue[]
}

export function isCatalogPricedItem(item: BoqItem): boolean {
  return isPricedBoqItem(item) && Number.isFinite(item.rate) && item.rate > 0
}

function issueFor(item: BoqItem, sectionIndex: number): CatalogReadinessIssue | null {
  if (item.stdStatus === 'matched' && item.stdId?.trim()) return null
  if (item.stdStatus === 'excluded' && item.stdExclusionReason?.trim()) return null
  return {
    sectionIndex,
    ...(item.id ? { itemId: item.id } : {}),
    ...(item.code ? { itemCode: item.code } : {}),
    description: item.desc,
    reason: item.stdStatus === 'excluded' ? 'Exclusion reason is required' : 'Catalog match is required',
  }
}

export function getBoqCatalogReadiness(boq: Pick<Boq, 'sections'>): BoqCatalogReadiness {
  let total = 0
  const items: CatalogReadinessIssue[] = []
  boq.sections.forEach((section, sectionIndex) => {
    section.items.forEach((item) => {
      if (!isCatalogPricedItem(item)) return
      total += 1
      const issue = issueFor(item, sectionIndex)
      if (issue) items.push(issue)
    })
  })
  return { total, resolved: total - items.length, blocking: items.length, items }
}
