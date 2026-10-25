import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import { canonicalUnit, unitsCompatible } from './standard-matching'

/**
 * How a quote line's unit relates to a catalog item's unit, for price comparison.
 * `catalogUnitsPerSourceUnit` = how many catalog units one quoted unit holds
 * (1 เส้น = 4 m → 4), so a rate per quoted unit becomes `rate / factor` per catalog unit.
 */
export interface RateConversion {
  ruleId: string
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: number
  scope: 'global' | 'catalog_item'
}

export type RateConverter = (
  sourceUnit: string,
  standard: { id: string; unit: string },
) => RateConversion | null

/** Active human-approved rules that can turn `sourceUnit` prices into catalog-unit prices. */
export function createRateConverter(
  rules: readonly HumanApprovedCatalogConversionRule[],
  unitMap: Record<string, string> = {},
): RateConverter {
  const active = rules
    .filter((rule) => rule.archivedAt === undefined)
    .map((rule) => ({ rule, factor: Number(rule.catalogUnitsPerSourceUnit) }))
    .filter(({ factor }) => Number.isFinite(factor) && factor > 0)
    .sort((left, right) => left.rule.id.localeCompare(right.rule.id))

  return (sourceUnit, standard) => {
    if (!sourceUnit.trim() || !standard.unit.trim()) return null
    if (unitsCompatible(sourceUnit, standard.unit, unitMap)) return null
    const from = canonicalUnit(sourceUnit, unitMap)
    const to = canonicalUnit(standard.unit, unitMap)
    const applies = (rule: HumanApprovedCatalogConversionRule) =>
      rule.scope === 'global' || rule.catalogId === standard.id
    const pick = (scope: 'catalog_item' | 'global'): RateConversion | null => {
      for (const { rule, factor } of active) {
        if (rule.scope !== scope || !applies(rule)) continue
        const ruleFrom = canonicalUnit(rule.sourceUnit, unitMap)
        const ruleTo = canonicalUnit(rule.catalogUnit, unitMap)
        if (ruleFrom === from && ruleTo === to) {
          return { ruleId: rule.id, sourceUnit, catalogUnit: standard.unit, catalogUnitsPerSourceUnit: factor, scope }
        }
        // A rule written the other way round (1 m = 0.25 เส้น) works too.
        if (ruleFrom === to && ruleTo === from) {
          return { ruleId: rule.id, sourceUnit, catalogUnit: standard.unit, catalogUnitsPerSourceUnit: 1 / factor, scope }
        }
      }
      return null
    }
    // A rule for this one catalog item wins over a general rule.
    return pick('catalog_item') ?? pick('global')
  }
}

/** Price per catalog unit, given a price per quoted unit. */
export function convertRate(rate: number, conversion: RateConversion): number {
  return rate / conversion.catalogUnitsPerSourceUnit
}
