import type { Boq, BoqPricedItem } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'
import { deriveSourceCostAllocation } from './boq-cost-allocation'
import type { StandardEntry } from './standard-schema'
import { canonicalUnit, rankCatalogMatches } from './standard-matching'
import { getBoqItemRequestIdentity } from './boq-item-identity'
import {
  buildCatalogComponentPricing,
  buildCatalogHistoricalPricing,
  createHistoricalStandardResolver,
  type CatalogComponentKey,
  type ComponentPriceSummary,
} from './catalog-historical-pricing'

export type ComponentKey = CatalogComponentKey

export interface ComponentComparison {
  present: boolean
  unit: string
  qty: number | null
  rate: number | null
  total: number | null
  basis: 'native' | 'line-unit' | 'none'
  benchmark: ComponentPriceSummary | null
  variancePct: number | null
}

export type ComponentComparisonMap =
  Record<ComponentKey, ComponentComparison>

export interface BoqCatalogComparisonRow {
  key: string
  sectionIndex: number
  section: string
  item: BoqPricedItem
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
  components: ComponentComparisonMap
}

export function formatHistoricalVariance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'No historical baseline'
  if (Math.abs(value) < 0.05) return 'At average'
  return `${Math.abs(value).toFixed(1)}% ${value < 0 ? 'below' : 'above'} average`
}

function absentComponent(): ComponentComparison {
  return {
    present: false,
    unit: '',
    qty: null,
    rate: null,
    total: null,
    basis: 'none',
    benchmark: null,
    variancePct: null,
  }
}

function deriveTargetComponents(item: BoqPricedItem): ComponentComparisonMap {
  const components: ComponentComparisonMap = {
    material: absentComponent(),
    labour: absentComponent(),
  }

  const hasNativeEvidence = Boolean(
    item.sourceCosts?.material.present
    || item.sourceCosts?.labour.present,
  )

  if (hasNativeEvidence && item.sourceCosts) {
    for (const key of ['material', 'labour'] as const) {
      const source = item.sourceCosts[key]
      if (
        !source.present
        || source.qty <= 0
        || !source.unit.trim()
        || !Number.isFinite(source.rate)
        || source.rate <= 0
      ) {
        continue
      }

      components[key] = {
        present: true,
        unit: source.unit,
        qty: source.qty,
        rate: source.rate,
        total: source.total,
        basis: 'native',
        benchmark: null,
        variancePct: null,
      }
    }

    return components
  }

  if (item.type === 'lump_sum' || item.qty <= 0) return components

  const allocation = deriveSourceCostAllocation(item)
  if (!allocation || allocation.basis !== 'rate') return components

  for (const key of ['material', 'labour'] as const) {
    const rate = allocation[key]
    if (!Number.isFinite(rate) || rate <= 0) continue

    components[key] = {
      present: true,
      unit: item.unit,
      qty: item.qty,
      rate,
      total: rate * item.qty,
      basis: 'line-unit',
      benchmark: null,
      variancePct: null,
    }
  }

  return components
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
  const componentPricing = buildCatalogComponentPricing(active, allBoqs, unitMap, { excludeBoqId: target.id })
  const rows = target.sections.flatMap((section, sectionIndex) => section.items.flatMap((item, itemIndex) => {
    if (!isPricedBoqItem(item)) return []
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
    const components = deriveTargetComponents(item)
    const matchedComponentPricing =
      candidate && matchedStandardId === candidate.standardId
        ? componentPricing.get(candidate.standardId)
        : undefined

    for (const key of ['material', 'labour'] as const) {
      const component = components[key]
      if (!component.present || component.rate === null) continue

      const unit = canonicalUnit(component.unit, unitMap)
      const componentBenchmark =
        matchedComponentPricing?.[key].get(unit)
        ?? null

      components[key] = {
        ...component,
        benchmark: componentBenchmark,
        variancePct:
          componentBenchmark && componentBenchmark.average > 0
            ? (
                (component.rate - componentBenchmark.average)
                / componentBenchmark.average
              ) * 100
            : null,
      }
    }

    return [{
      key: `${sectionIndex}-${item.id ?? item.code ?? itemIndex}`,
      sectionIndex,
      section: section.header,
      item,
      identity: getBoqItemRequestIdentity(item),
      candidate,
      benchmark,
      variancePct: benchmark && item.rate > 0 ? ((item.rate - benchmark.average) / benchmark.average) * 100 : null,
      components,
    }]
  }))
  return { boqId: target.id, rows }
}
