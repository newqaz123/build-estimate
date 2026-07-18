import type { Boq, BoqItem } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import { unitsCompatible } from './standard-matching'

export interface HistoricalPriceSource {
  boqId: string
  project: string
  vendor: string
  date: string
  section: string
  itemId?: string
  itemCode?: string
  description: string
  unit: string
  rate: number
}

export interface HistoricalPriceSummary {
  count: number
  min: number
  average: number
  max: number
  sources: HistoricalPriceSource[]
}

function provenanceKey(boqId: string, sectionIndex: number, item: Pick<BoqItem, 'id' | 'code'>): string | null {
  if (item.id?.trim()) return JSON.stringify([boqId, sectionIndex, 'id', item.id.trim()])
  if (item.code?.trim()) return JSON.stringify([boqId, sectionIndex, 'code', item.code.trim()])
  return null
}

function buildProvenanceIndex(standards: StandardEntry[]): Map<string, string | null> {
  const index = new Map<string, string | null>()
  for (const standard of standards) {
    for (const source of standard.sourceItems ?? []) {
      const key = provenanceKey(source.boqId, source.sectionIndex, { id: source.itemId, code: source.itemCode })
      if (!key) continue
      const current = index.get(key)
      index.set(key, current && current !== standard.id ? null : standard.id)
    }
  }
  return index
}

export function createHistoricalStandardResolver(standards: StandardEntry[]) {
  const active = standards.filter((standard) => !standard.archivedAt)
  const byId = new Map(active.map((standard) => [standard.id, standard]))
  const provenance = buildProvenanceIndex(active)

  return {
    active,
    byId,
    resolve(boqId: string, sectionIndex: number, item: BoqItem): string | undefined {
      if (item.stdStatus !== 'matched') return undefined
      if (item.stdId && byId.has(item.stdId)) return item.stdId
      const key = provenanceKey(boqId, sectionIndex, item)
      const standardId = key ? provenance.get(key) : undefined
      return standardId ?? undefined
    },
  }
}

export function buildCatalogHistoricalPricing(
  standards: StandardEntry[],
  boqs: Boq[],
  unitMap: Record<string, string> = {},
  options: { excludeBoqId?: string } = {},
): Map<string, HistoricalPriceSummary> {
  const resolver = createHistoricalStandardResolver(standards)
  const grouped = new Map<string, HistoricalPriceSource[]>()

  for (const boq of boqs) {
    if (boq.status !== 'approved' || boq.id === options.excludeBoqId) continue
    boq.sections.forEach((section, sectionIndex) => {
      section.items.forEach((item) => {
        if (item.stdStatus !== 'matched' || !Number.isFinite(item.rate) || item.rate <= 0) return
        const standardId = resolver.resolve(boq.id, sectionIndex, item)
        if (!standardId) return
        const standard = resolver.byId.get(standardId)
        if (!standard || !unitsCompatible(item.unit, standard.unit, unitMap)) return

        const source: HistoricalPriceSource = {
          boqId: boq.id,
          project: boq.project,
          vendor: boq.vendor,
          date: boq.date,
          section: section.header,
          ...(item.id ? { itemId: item.id } : {}),
          ...(item.code ? { itemCode: item.code } : {}),
          description: item.desc,
          unit: item.unit,
          rate: item.rate,
        }
        const sources = grouped.get(standardId)
        if (sources) sources.push(source)
        else grouped.set(standardId, [source])
      })
    })
  }

  const result = new Map<string, HistoricalPriceSummary>()
  for (const [standardId, sources] of grouped) {
    let total = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const source of sources) {
      total += source.rate
      min = Math.min(min, source.rate)
      max = Math.max(max, source.rate)
    }
    result.set(standardId, { count: sources.length, min, average: total / sources.length, max, sources })
  }
  return result
}
