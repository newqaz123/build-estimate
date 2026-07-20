import type { BoqPricedItem } from './boq-schema'
import { rankCatalogMatches } from './standard-matching'
import type { StandardEntry } from './standard-schema'

export interface InlineCatalogSuggestion {
  standardId: string
  description: string
  unit: string
  source: 'local' | 'llm'
  confidence: 'exact' | 'fuzzy' | 'llm'
  reason: 'Exact' | 'Alias' | 'Similar' | 'AI suggestion'
}

const FUZZY_SUGGESTION_MINIMUM_SCORE = 1125

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localSuggestionReason(matchReason: 'exact' | 'alias' | 'fuzzy'): Pick<InlineCatalogSuggestion, 'confidence' | 'reason'> {
  if (matchReason === 'alias') return { confidence: 'exact', reason: 'Alias' }
  if (matchReason === 'fuzzy') return { confidence: 'fuzzy', reason: 'Similar' }
  return { confidence: 'exact', reason: 'Exact' }
}

export function qualifyingLocalSuggestions(
  item: Pick<BoqPricedItem, 'desc' | 'unit' | 'stdStatus' | 'stdId'>,
  standards: StandardEntry[],
  unitMap: Record<string, string>,
  dismissedStandardIds: ReadonlySet<string> = new Set(),
): InlineCatalogSuggestion[] {
  if (item.stdStatus === 'matched' || item.stdStatus === 'excluded') return []

  return rankCatalogMatches(item.desc, item.unit, standards.filter((standard) => !standard.archivedAt), unitMap)
    .filter((candidate) => {
      if (!candidate.unitCompatible || dismissedStandardIds.has(candidate.id)) return false
      return candidate.matchReason === 'exact'
        || candidate.matchReason === 'alias'
        || candidate.score >= FUZZY_SUGGESTION_MINIMUM_SCORE
    })
    .map((candidate) => ({
      standardId: candidate.id,
      description: candidate.description,
      unit: candidate.unit,
      source: 'local' as const,
      ...localSuggestionReason(candidate.matchReason),
    }))
}

export function suggestionFromLlmResponse(
  response: unknown,
  standards: StandardEntry[],
  expectedKey: string,
): InlineCatalogSuggestion | null {
  if (!isRecord(response) || !Array.isArray(response.suggestions)) return null

  const standardsById = new Map(
    standards.filter((standard) => !standard.archivedAt).map((standard) => [standard.id, standard]),
  )

  for (const candidate of response.suggestions) {
    if (!isRecord(candidate)) continue
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : ''
    const standardId = typeof candidate.standardId === 'string' ? candidate.standardId.trim() : ''
    const standard = standardsById.get(standardId)
    if (key !== expectedKey || !standard) continue

    return {
      standardId: standard.id,
      description: standard.description,
      unit: standard.unit,
      source: 'llm',
      confidence: 'llm',
      reason: 'AI suggestion',
    }
  }

  return null
}
