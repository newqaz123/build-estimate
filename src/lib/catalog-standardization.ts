import type { StandardEntry } from './standard-schema'

export interface CatalogStandardizationItem {
  key: string
  description: string
  unit: string
}

export interface CatalogStandardizationRequest {
  items: CatalogStandardizationItem[]
}

export interface CatalogStandardizationSuggestion {
  key: string
  standardId: string
  description: string
  unit: string
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCatalogStandardizationRequest(value: unknown): CatalogStandardizationRequest {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length === 0) {
    throw new TypeError('items must be a non-empty array.')
  }
  if (value.items.length > 100) throw new TypeError('items cannot contain more than 100 rows.')

  const items = value.items.map((candidate, index) => {
    if (!isRecord(candidate)) throw new TypeError(`items[${index}] must be an object.`)
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : ''
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : ''
    const unit = typeof candidate.unit === 'string' ? candidate.unit.trim() : ''
    if (!key || key.length > 200) throw new TypeError(`items[${index}].key is invalid.`)
    if (!description || description.length > 2000) throw new TypeError(`items[${index}].description is invalid.`)
    if (!unit || unit.length > 100) throw new TypeError(`items[${index}].unit is invalid.`)
    return { key, description, unit }
  })

  if (new Set(items.map((item) => item.key)).size !== items.length) {
    throw new TypeError('item keys must be unique.')
  }
  return { items }
}

export function buildCatalogStandardizationPrompt(
  request: CatalogStandardizationRequest,
  standards: StandardEntry[],
): string {
  const catalog = standards.map((standard) => ({
    id: standard.id,
    description: standard.description,
    unit: standard.unit,
    aliases: standard.aliases ?? [],
  }))
  return [
    'Match each BOQ item to at most one existing Standard Catalog ID.',
    'Never invent an ID and omit an item when no catalog entry fits.',
    'Return JSON only: [{"key":"requested key","standardId":"known ID","reason":"brief reason"}].',
    `Catalog: ${JSON.stringify(catalog)}`,
    `BOQ items: ${JSON.stringify(request.items)}`,
  ].join('\n')
}

export function normalizeCatalogStandardizationResponse(
  content: string,
  request: CatalogStandardizationRequest,
  standards: StandardEntry[],
): CatalogStandardizationSuggestion[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const requestedKeys = new Set(request.items.map((item) => item.key))
  const standardsById = new Map(standards.map((standard) => [standard.id, standard]))
  const seen = new Set<string>()
  const suggestions: CatalogStandardizationSuggestion[] = []
  for (const candidate of parsed) {
    if (!isRecord(candidate)) continue
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : ''
    const standardId = typeof candidate.standardId === 'string' ? candidate.standardId.trim() : ''
    const reason = typeof candidate.reason === 'string' ? candidate.reason.trim().slice(0, 500) : ''
    const standard = standardsById.get(standardId)
    if (!requestedKeys.has(key) || !standard || seen.has(key)) continue
    seen.add(key)
    suggestions.push({
      key,
      standardId,
      description: standard.description,
      unit: standard.unit,
      reason: reason || 'AI suggested an active catalog match.',
    })
  }
  return suggestions
}
