import type { Boq, BoqItem } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import { rankCatalogMatches } from './standard-matching'
import { getBoqItemRequestIdentity } from './boq-item-identity'
import { buildCatalogHistoricalPricing, createHistoricalStandardResolver } from './catalog-historical-pricing'

export interface BoqCatalogComparisonRow {
  key: string
  sectionIndex: number
  section: string
  item: BoqItem
  identity: ReturnType<typeof getBoqItemRequestIdentity>
  candidate: null | {
    standardId: string
    description: string
    unit: string
    score: number
    matchReason: 'exact' | 'alias' | 'fuzzy' | 'linked'
  }
  benchmark: null | { count: number; min: number; average: number; max: number }
  variancePct: number | null
}

export function formatHistoricalVariance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'No historical baseline'
  if (Math.abs(value) < 0.05) return 'At average'
  return `${Math.abs(value).toFixed(1)}% ${value < 0 ? 'below' : 'above'} average`
}

export function compareBoqToCatalog(
  target: Boq,
  standards: StandardEntry[],
  allBoqs: Boq[],
  unitMap: Record<string, string> = {},
): { boqId: string; rows: BoqCatalogComparisonRow[] } {
  const resolver = createHistoricalStandardResolver(standards)
  const { active, byId } = resolver
  const historicalPricing = buildCatalogHistoricalPricing(active, allBoqs, unitMap, { excludeBoqId: target.id })
  const rows = target.sections.flatMap((section, sectionIndex) => section.items.map((item, itemIndex) => {
    const linked = item.stdId ? byId.get(item.stdId) : undefined
    const ranked = linked ? undefined : rankCatalogMatches(item.desc, item.unit, active, unitMap)
      .find((candidate) => candidate.unitCompatible && candidate.score >= 1100)
    const standard = linked ?? (ranked ? byId.get(ranked.id) : undefined)
    const candidate = standard ? {
      standardId: standard.id,
      description: standard.description,
      unit: standard.unit,
      score: linked ? 2000 : ranked!.score,
      matchReason: linked ? 'linked' as const : ranked!.matchReason,
    } : null
    const matchedStandardId = resolver.resolve(target.id, sectionIndex, item)
    const pricing = candidate && matchedStandardId === candidate.standardId
      ? historicalPricing.get(candidate.standardId) ?? null
      : null
    const benchmark = pricing
      ? { count: pricing.count, min: pricing.min, average: pricing.average, max: pricing.max }
      : null
    return {
      key: `${sectionIndex}-${item.id ?? item.code ?? itemIndex}`,
      sectionIndex,
      section: section.header,
      item,
      identity: getBoqItemRequestIdentity(item),
      candidate,
      benchmark,
      variancePct: benchmark && item.rate > 0 ? ((item.rate - benchmark.average) / benchmark.average) * 100 : null,
    }
  }))
  return { boqId: target.id, rows }
}
