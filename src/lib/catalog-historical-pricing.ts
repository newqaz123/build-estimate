import type { Boq, BoqItem, BoqPricedItem } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'
import { deriveSourceCostAllocation } from './boq-cost-allocation'
import type { StandardEntry } from './standard-schema'
import {
  canonicalUnit,
  unitsCompatible,
} from './standard-matching'

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

export type CatalogComponentKey = 'material' | 'labour'

export interface ComponentPriceSummary {
  unit: string
  count: number
  min: number
  average: number
  max: number
}

export interface CatalogComponentPricing {
  material: Map<string, ComponentPriceSummary>
  labour: Map<string, ComponentPriceSummary>
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
        if (!isPricedBoqItem(item) || item.stdStatus !== 'matched' || !Number.isFinite(item.rate) || item.rate <= 0) return
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

const COMPONENT_KEYS: CatalogComponentKey[] = ['material', 'labour']

function emptyComponentPricing(): CatalogComponentPricing {
  return {
    material: new Map(),
    labour: new Map(),
  }
}

function summarizeRates(
  unit: string,
  rates: number[],
): ComponentPriceSummary {
  return {
    unit,
    count: rates.length,
    min: Math.min(...rates),
    average: rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
    max: Math.max(...rates),
  }
}

function hasNativeComponentEvidence(item: BoqPricedItem): boolean {
  return Boolean(
    item.sourceCosts?.material.present
    || item.sourceCosts?.labour.present,
  )
}

function derivedComponentRates(
  item: BoqPricedItem,
  standard: StandardEntry,
  unitMap: Record<string, string>,
): Partial<Record<CatalogComponentKey, {
  unit: string
  rate: number
}>> {
  if (
    hasNativeComponentEvidence(item)
    || item.type === 'lump_sum'
    || item.qty <= 0
    || !unitsCompatible(item.unit, standard.unit, unitMap)
  ) {
    return {}
  }

  const allocation = deriveSourceCostAllocation(item)
  if (!allocation || allocation.basis !== 'rate') return {}

  // A non-finite component signals corrupt allocation data; reject the
  // whole record so a single bad value cannot seed benchmark history.
  for (const key of COMPONENT_KEYS) {
    if (!Number.isFinite(allocation[key])) return {}
  }

  const unit = canonicalUnit(item.unit, unitMap)
  const result: Partial<Record<CatalogComponentKey, {
    unit: string
    rate: number
  }>> = {}

  for (const key of COMPONENT_KEYS) {
    const rate = allocation[key]
    if (Number.isFinite(rate) && rate > 0) {
      result[key] = { unit, rate }
    }
  }

  return result
}

export function buildCatalogComponentPricing(
  standards: StandardEntry[],
  boqs: Boq[],
  unitMap: Record<string, string> = {},
  options: { excludeBoqId?: string } = {},
): Map<string, CatalogComponentPricing> {
  const resolver = createHistoricalStandardResolver(standards)
  const grouped = new Map<
    string,
    Record<CatalogComponentKey, Map<string, number[]>>
  >()

  for (const boq of boqs) {
    if (
      boq.status !== 'approved'
      || boq.id === options.excludeBoqId
    ) {
      continue
    }

    boq.sections.forEach((section, sectionIndex) => {
      section.items.forEach((item) => {
        if (!isPricedBoqItem(item)
          || item.stdStatus !== 'matched'
          || item.type === 'lump_sum'
        ) {
          return
        }

        const standardId = resolver.resolve(boq.id, sectionIndex, item)
        if (!standardId) return

        const standard = resolver.byId.get(standardId)
        if (!standard) return

        const standardGroups = grouped.get(standardId) ?? {
          material: new Map<string, number[]>(),
          labour: new Map<string, number[]>(),
        }

        let added = false

        if (hasNativeComponentEvidence(item)) {
          for (const key of COMPONENT_KEYS) {
            const source = item.sourceCosts?.[key]
            if (
              !source?.present
              || source.qty <= 0
              || !source.unit.trim()
              || !Number.isFinite(source.rate)
              || source.rate <= 0
            ) {
              continue
            }

            const unit = canonicalUnit(source.unit, unitMap)
            const rates = standardGroups[key].get(unit) ?? []
            rates.push(source.rate)
            standardGroups[key].set(unit, rates)
            added = true
          }
        } else {
          const derived = derivedComponentRates(item, standard, unitMap)
          for (const key of COMPONENT_KEYS) {
            const entry = derived[key]
            if (!entry) continue

            const rates = standardGroups[key].get(entry.unit) ?? []
            rates.push(entry.rate)
            standardGroups[key].set(entry.unit, rates)
            added = true
          }
        }

        if (added) grouped.set(standardId, standardGroups)
      })
    })
  }

  const result = new Map<string, CatalogComponentPricing>()

  for (const [standardId, groups] of grouped) {
    const pricing = emptyComponentPricing()

    for (const key of COMPONENT_KEYS) {
      for (const [unit, rates] of groups[key]) {
        pricing[key].set(unit, summarizeRates(unit, rates))
      }
    }

    result.set(standardId, pricing)
  }

  return result
}
