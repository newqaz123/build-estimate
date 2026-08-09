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

function findConversionRule(
  rules: readonly HumanApprovedCatalogConversionRule[],
  sourceUnit: string,
  catalogId: string,
  catalogUnit: string,
): HumanApprovedCatalogConversionRule | null {
  let globalMatch: HumanApprovedCatalogConversionRule | null = null

  for (const rule of rules) {
    if (!isActiveRule(rule)) continue
    if (rule.sourceUnit !== sourceUnit || rule.catalogUnit !== catalogUnit) continue

    if (rule.scope === 'catalog_item') {
      if (rule.catalogId === catalogId) return rule
      continue
    }

    if (rule.scope === 'global' && globalMatch === null) {
      globalMatch = rule
    }
  }

  return globalMatch
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
  const catalogById = new Map(activeCatalog.map((entry) => [entry.id, entry]))
  const candidates: CatalogCandidateSnapshot[] = []

  if (input.sourceSignature) {
    for (const mapping of input.approvedMappings ?? []) {
      if (mapping.sourceSignature !== input.sourceSignature) continue
      const entry = catalogById.get(mapping.catalogId)
      if (!entry) continue
      const snapshot: CatalogCandidateSnapshot = {
        catalogId: entry.id,
        description: entry.description,
        unit: entry.unit,
        matchKind: 'approved_history',
        score: APPROVED_HISTORY_SCORE,
      }
      if (mapping.conversionRuleId !== undefined) {
        snapshot.conversionRuleId = mapping.conversionRuleId
      }
      candidates.push(snapshot)
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
