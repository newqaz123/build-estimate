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
  lastMatched?: string
  archivedAt?: string
  createdAt: string
  updatedAt: string
}
