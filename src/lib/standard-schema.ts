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
  /** Set on an entry archived by a merge: the entry it was merged into. */
  mergedInto?: string
  /** Set on the kept entry: what the last merge changed, so it can be undone. */
  lastMerge?: import('./catalog-merge').MergeUndoRecord
  createdAt: string
  updatedAt: string
}
