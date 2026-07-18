import type { HistoricalPriceSummary } from './catalog-historical-pricing'

export interface StandardSourceItem {
  boqId: string
  sectionIndex: number
  itemId?: string
  itemCode?: string
  sourceDescription: string
}

export interface StandardEntry {
  id: string
  description: string
  unit: string
  category?: string
  aliases: string[]
  sourceItems?: StandardSourceItem[]
  sourceBoqCount: number
  historicalPricing?: HistoricalPriceSummary
  lastMatched?: string
  archivedAt?: string
  createdAt: string
  updatedAt: string
}
