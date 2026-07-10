export interface StandardEntry {
  id: string
  description: string
  unit: string
  category?: string
  aliases: string[]
  sourceBoqCount: number
  lastMatched?: string
  createdAt: string
  updatedAt: string
}
