import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import type { ApprovedCatalogMapping } from './catalog-mapping-cache'
import {
  scoreCatalogTextMatch,
  unitsCompatible,
} from './standard-matching'

export interface CatalogCandidateSnapshot {
  catalogId: string
  description: string
  unit: string
  matchKind: 'approved_history' | 'exact' | 'alias' | 'fuzzy' | 'conversion'
  score: number
  conversionRuleId?: string
}

export interface CatalogShortlistCatalogEntry {
  id: string
  description: string
  unit: string
  aliases?: string[]
  archivedAt?: string
}

export interface CatalogShortlistInput {
  description: string
  unit: string
  catalog: readonly CatalogShortlistCatalogEntry[]
  unitMap: Record<string, string>
  conversionRules?: readonly HumanApprovedCatalogConversionRule[]
  approvedMappings?: readonly ApprovedCatalogMapping[]
  sourceSignature?: string
}

const MATCH_KIND_RANK: Record<CatalogCandidateSnapshot['matchKind'], number> = {
  approved_history: 0,
  exact: 1,
  alias: 2,
  fuzzy: 3,
  conversion: 4,
}

const APPROVED_HISTORY_SCORE = 5000
const UNIT_COMPATIBLE_BOOST = 1000
const MAX_CANDIDATES = 3

function isActiveStandard(entry: CatalogShortlistCatalogEntry): boolean {
  return entry.archivedAt === undefined
}

function isActiveRule(rule: HumanApprovedCatalogConversionRule): boolean {
  return rule.archivedAt === undefined
}

function ruleMatchesTarget(
  rule: HumanApprovedCatalogConversionRule,
  sourceUnit: string,
  catalogId: string,
  catalogUnit: string,
): boolean {
  if (!isActiveRule(rule)) return false
  if (rule.sourceUnit !== sourceUnit || rule.catalogUnit !== catalogUnit) return false
  if (rule.scope === 'catalog_item') {
    return rule.catalogId === catalogId
  }
  return rule.scope === 'global'
}

function pickLowestIdRule(
  rules: readonly HumanApprovedCatalogConversionRule[],
): HumanApprovedCatalogConversionRule | null {
  if (rules.length === 0) return null
  return [...rules].sort((left, right) => left.id.localeCompare(right.id))[0] ?? null
}

/**
 * Prefer catalog-item rules over global; within a family pick lowest stable id.
 */
function findConversionRule(
  rules: readonly HumanApprovedCatalogConversionRule[],
  sourceUnit: string,
  catalogId: string,
  catalogUnit: string,
): HumanApprovedCatalogConversionRule | null {
  const itemMatches: HumanApprovedCatalogConversionRule[] = []
  const globalMatches: HumanApprovedCatalogConversionRule[] = []

  for (const rule of rules) {
    if (!ruleMatchesTarget(rule, sourceUnit, catalogId, catalogUnit)) continue
    if (rule.scope === 'catalog_item') itemMatches.push(rule)
    else globalMatches.push(rule)
  }

  return pickLowestIdRule(itemMatches) ?? pickLowestIdRule(globalMatches)
}

/**
 * Resolve mapping.conversionRuleId only when the referenced rule is active and
 * exactly matches source/catalog units plus scope/catalogId. Never echo bad IDs.
 */
function resolveMappedConversionRule(
  mapping: ApprovedCatalogMapping,
  sourceUnit: string,
  catalogId: string,
  catalogUnit: string,
  rulesById: ReadonlyMap<string, HumanApprovedCatalogConversionRule>,
): HumanApprovedCatalogConversionRule | null {
  const ruleId = mapping.conversionRuleId
  if (typeof ruleId !== 'string' || ruleId.trim() === '') return null
  const rule = rulesById.get(ruleId)
  if (!rule) return null
  if (!ruleMatchesTarget(rule, sourceUnit, catalogId, catalogUnit)) return null
  return rule
}

function approvedHistoryCandidate(
  mapping: ApprovedCatalogMapping,
  entry: CatalogShortlistCatalogEntry,
  sourceUnit: string,
  unitMap: Record<string, string>,
  rulesById: ReadonlyMap<string, HumanApprovedCatalogConversionRule>,
): CatalogCandidateSnapshot | null {
  const compatible = unitsCompatible(sourceUnit, entry.unit, unitMap)

  if (compatible) {
    // Compatible units: eligible without a conversion rule.
    // Never echo a stale/unresolved conversionRuleId on the snapshot.
    return {
      catalogId: entry.id,
      description: entry.description,
      unit: entry.unit,
      matchKind: 'approved_history',
      score: APPROVED_HISTORY_SCORE,
    }
  }

  // Incompatible units: require a validated active human-approved rule.
  const rule = resolveMappedConversionRule(
    mapping,
    sourceUnit,
    entry.id,
    entry.unit,
    rulesById,
  )
  if (!rule) return null

  return {
    catalogId: entry.id,
    description: entry.description,
    unit: entry.unit,
    matchKind: 'approved_history',
    score: APPROVED_HISTORY_SCORE,
    conversionRuleId: rule.id,
  }
}

function compareCandidates(
  left: CatalogCandidateSnapshot,
  right: CatalogCandidateSnapshot,
): number {
  const kindDelta = MATCH_KIND_RANK[left.matchKind] - MATCH_KIND_RANK[right.matchKind]
  if (kindDelta !== 0) return kindDelta
  if (right.score !== left.score) return right.score - left.score
  return left.catalogId.localeCompare(right.catalogId)
}

function keepBestByCatalogId(
  candidates: CatalogCandidateSnapshot[],
): CatalogCandidateSnapshot[] {
  const best = new Map<string, CatalogCandidateSnapshot>()
  for (const candidate of candidates) {
    const existing = best.get(candidate.catalogId)
    if (!existing || compareCandidates(candidate, existing) < 0) {
      best.set(candidate.catalogId, candidate)
    }
  }
  return [...best.values()]
}

/**
 * Local-first shortlist: approved history → exact → alias → compatible fuzzy →
 * active valid conversion. Caps at three after filtering. Deterministic catalog-id ties.
 */
export function shortlistCatalogCandidates(
  input: CatalogShortlistInput,
): CatalogCandidateSnapshot[] {
  const activeCatalog = input.catalog.filter(isActiveStandard)
  if (activeCatalog.length === 0) return []

  const activeRules = (input.conversionRules ?? []).filter(isActiveRule)
  const rulesById = new Map(activeRules.map((rule) => [rule.id, rule]))
  const catalogById = new Map(activeCatalog.map((entry) => [entry.id, entry]))
  const candidates: CatalogCandidateSnapshot[] = []

  if (input.sourceSignature) {
    for (const mapping of input.approvedMappings ?? []) {
      if (mapping.sourceSignature !== input.sourceSignature) continue
      const entry = catalogById.get(mapping.catalogId)
      if (!entry) continue
      const snapshot = approvedHistoryCandidate(
        mapping,
        entry,
        input.unit,
        input.unitMap,
        rulesById,
      )
      if (snapshot) candidates.push(snapshot)
    }
  }

  for (const entry of activeCatalog) {
    const { score: baseScore, reason } = scoreCatalogTextMatch(
      input.description,
      entry.description,
      entry.aliases ?? [],
    )
    if (baseScore <= 0) continue

    const compatible = unitsCompatible(input.unit, entry.unit, input.unitMap)
    if (compatible) {
      candidates.push({
        catalogId: entry.id,
        description: entry.description,
        unit: entry.unit,
        matchKind: reason,
        score: baseScore + UNIT_COMPATIBLE_BOOST,
      })
      continue
    }

    const conversionRule = findConversionRule(
      activeRules,
      input.unit,
      entry.id,
      entry.unit,
    )
    if (!conversionRule) continue

    candidates.push({
      catalogId: entry.id,
      description: entry.description,
      unit: entry.unit,
      matchKind: 'conversion',
      score: baseScore,
      conversionRuleId: conversionRule.id,
    })
  }

  return keepBestByCatalogId(candidates)
    .sort(compareCandidates)
    .slice(0, MAX_CANDIDATES)
}
