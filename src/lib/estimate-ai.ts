import type { StandardEntry } from './standard-schema'

export interface EstimateAiCatalogEntry {
  id: string
  description: string
  unit: string
  category?: string
  defaultQty?: number
  defaultRate?: number
}

export interface EstimateAiEstimateItem {
  desc: string
  unit: string
  qty: number
  rate: number
  stdId?: string
}

export interface EstimateAiCatalogContext {
  available: EstimateAiCatalogEntry[]
  selected: EstimateAiCatalogEntry[]
}

export interface EstimateAiHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface EstimateAiRequest {
  message: string
  estimate: {
    projectName: string
    date: string
    notes: string
    items: EstimateAiEstimateItem[]
  }
  catalog: EstimateAiCatalogContext
  history: EstimateAiHistoryMessage[]
  provider?: string
  model?: string
}

export interface EstimateAiSuggestion {
  description: string
  unit: string
  quantity: number
  rate: number
  source: 'catalog' | 'manual'
  reason: string
  stdId?: string
}

export interface CatalogEstimateItem {
  desc: string
  unit: string
  qty: number
  rate: number
  total: number
  source: 'imported'
  stdId: string
  stdSnapshot: { description: string; unit: string }
}

export interface EstimateAiResponse {
  assistantText: string
  suggestions: EstimateAiSuggestion[]
  fallback?: boolean
}

type ValidationResult =
  | { ok: true; value: EstimateAiRequest }
  | { ok: false; error: string }

const MAX_MESSAGE_LENGTH = 4_000
const MAX_CONTEXT_ITEMS = 200
const MAX_CATALOG_ITEMS = 100
const MAX_TEXT_LENGTH = 1_000
const MAX_HISTORY_MESSAGES = 20
const MAX_HISTORY_CONTENT_LENGTH = 4_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, max = MAX_TEXT_LENGTH, allowBlank = true): value is string {
  return typeof value === 'string'
    && value.length <= max
    && (allowBlank || value.trim().length > 0)
}

function nonNegativeNumber(value: unknown, fallback?: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function normalizeCatalogEntry(value: unknown): EstimateAiCatalogEntry | null {
  if (!isRecord(value) || !boundedString(value.id, 200, false) || !boundedString(value.description, MAX_TEXT_LENGTH, false) || !boundedString(value.unit, 100, false)) return null

  const entry: EstimateAiCatalogEntry = {
    id: value.id.trim(),
    description: value.description.trim(),
    unit: value.unit.trim(),
  }
  if (boundedString(value.category, 200, false)) entry.category = value.category.trim()
  const defaultQty = nonNegativeNumber(value.defaultQty)
  const defaultRate = nonNegativeNumber(value.defaultRate)
  if (defaultQty !== undefined) entry.defaultQty = defaultQty
  if (defaultRate !== undefined) entry.defaultRate = defaultRate
  return entry
}

function normalizeCatalogList(value: unknown): EstimateAiCatalogEntry[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ITEMS) return null

  const result: EstimateAiCatalogEntry[] = []
  const ids = new Set<string>()
  for (const item of value) {
    const entry = normalizeCatalogEntry(item)
    if (!entry) return null
    if (ids.has(entry.id)) continue
    ids.add(entry.id)
    result.push(entry)
  }
  return result
}

function normalizeEstimateItem(value: unknown): EstimateAiEstimateItem | null {
  if (!isRecord(value) || !boundedString(value.desc, MAX_TEXT_LENGTH) || !boundedString(value.unit, 100)) return null
  const qty = nonNegativeNumber(value.qty)
  const rate = nonNegativeNumber(value.rate)
  if (qty === undefined || rate === undefined) return null

  return {
    desc: value.desc.trim(),
    unit: value.unit.trim(),
    qty,
    rate,
    ...(boundedString(value.stdId, 200, false) ? { stdId: value.stdId.trim() } : {}),
  }
}

function normalizeHistory(value: unknown): EstimateAiHistoryMessage[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_HISTORY_MESSAGES) return null

  const history: EstimateAiHistoryMessage[] = []
  for (const item of value) {
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant') || !boundedString(item.content, MAX_HISTORY_CONTENT_LENGTH, false)) {
      return null
    }
    history.push({ role: item.role, content: item.content.trim() })
  }
  return history
}

export function validateEstimateAiRequest(input: unknown): ValidationResult {
  if (!isRecord(input) || !boundedString(input.message, MAX_MESSAGE_LENGTH, false)) {
    return { ok: false, error: 'A message between 1 and 4000 characters is required' }
  }

  const estimateInput = input.estimate
  if (estimateInput !== undefined && !isRecord(estimateInput)) {
    return { ok: false, error: 'Estimate context must be an object' }
  }
  const catalogInput = input.catalog
  if (catalogInput !== undefined && !isRecord(catalogInput)) {
    return { ok: false, error: 'Catalog context must be an object' }
  }

  const estimateItemsInput = isRecord(estimateInput) ? estimateInput.items : undefined
  if (estimateItemsInput !== undefined && (!Array.isArray(estimateItemsInput) || estimateItemsInput.length > MAX_CONTEXT_ITEMS)) {
    return { ok: false, error: 'Estimate context contains too many items' }
  }

  const items: EstimateAiEstimateItem[] = []
  for (const item of (estimateItemsInput ?? [])) {
    const normalized = normalizeEstimateItem(item)
    if (!normalized) return { ok: false, error: 'Estimate items are malformed' }
    items.push(normalized)
  }

  const available = normalizeCatalogList(isRecord(catalogInput) ? catalogInput.available : undefined)
  const selected = normalizeCatalogList(isRecord(catalogInput) ? catalogInput.selected : undefined)
  if (!available || !selected) return { ok: false, error: 'Catalog context is malformed' }
  const history = normalizeHistory(input.history)
  if (!history) return { ok: false, error: 'Chat history is malformed or too long' }

  const projectName = isRecord(estimateInput) && boundedString(estimateInput.projectName, 300) ? estimateInput.projectName.trim() : ''
  const date = isRecord(estimateInput) && boundedString(estimateInput.date, 100) ? estimateInput.date.trim() : ''
  const notes = isRecord(estimateInput) && boundedString(estimateInput.notes, MAX_MESSAGE_LENGTH) ? estimateInput.notes.trim() : ''
  const provider = boundedString(input.provider, 50, false) ? input.provider.trim() : undefined
  const model = boundedString(input.model, 200, false) ? input.model.trim() : undefined

  return {
    ok: true,
    value: {
      message: input.message.trim(),
      estimate: { projectName, date, notes, items },
      catalog: { available, selected },
      history,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    },
  }
}

export function buildEstimateAiUserMessage(request: EstimateAiRequest): string {
  return [
    'Estimate builder request:',
    request.message,
    '',
    'Current estimate context (do not mutate it automatically):',
    JSON.stringify(request.estimate),
    '',
    'Supplied catalog context:',
    JSON.stringify(request.catalog),
    '',
    'Chat history for refining prior suggestions:',
    JSON.stringify(request.history),
    'Use this history to refine prior suggestions, while still treating catalog IDs as valid only when supplied in the current catalog context.',
    '',
    'Only use stdId values from the supplied catalog context. If there is no exact catalog match, omit stdId and mark the suggestion as manual/new.',
    'Return JSON with message and suggestions[{stdId, description, unit, quantity, rate, source, reason}].',
  ].join('\n')
}

export function filterCatalogContextToActiveEntries(
  context: EstimateAiCatalogContext,
  activeEntries: Array<Pick<EstimateAiCatalogEntry, 'id' | 'description' | 'unit' | 'category' | 'defaultRate'> & { archivedAt?: string }>,
): EstimateAiCatalogContext {
  const activeById = new Map<string, EstimateAiCatalogEntry>()
  for (const entry of activeEntries) {
    if (entry.archivedAt || !entry.id.trim() || !entry.description.trim() || !entry.unit.trim()) continue
    const defaultRate = nonNegativeNumber(entry.defaultRate)
    activeById.set(entry.id, {
      id: entry.id,
      description: entry.description.trim(),
      unit: entry.unit.trim(),
      ...(entry.category?.trim() ? { category: entry.category.trim() } : {}),
      ...(defaultRate !== undefined ? { defaultRate } : {}),
    })
  }

  const canonicalize = (entries: EstimateAiCatalogEntry[]) => {
    const seen = new Set<string>()
    return entries.flatMap((entry) => {
      if (seen.has(entry.id)) return []
      const active = activeById.get(entry.id)
      if (!active) return []
      seen.add(entry.id)
      return [active]
    })
  }

  return {
    available: canonicalize(context.available),
    selected: canonicalize(context.selected),
  }
}

function parseModelPayload(content: unknown): unknown {
  if (typeof content !== 'string') return content
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned) as unknown
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as unknown
    } catch {
      return null
    }
  }
}

function suggestionNumber(value: unknown, fallback: number): number {
  return nonNegativeNumber(value, fallback) ?? fallback
}

export function catalogEntryToEstimateItem(
  entry: EstimateAiCatalogEntry,
  defaults: { quantity?: number; rate?: number } = {},
): CatalogEstimateItem {
  const qty = suggestionNumber(defaults.quantity, entry.defaultQty ?? 1)
  const rate = suggestionNumber(defaults.rate, entry.defaultRate ?? 0)
  return {
    desc: entry.description,
    unit: entry.unit,
    qty,
    rate,
    total: qty * rate,
    source: 'imported',
    stdId: entry.id,
    stdSnapshot: { description: entry.description, unit: entry.unit },
  }
}

export function standardEntryToEstimateAiCatalogEntry(entry: StandardEntry): EstimateAiCatalogEntry {
  return {
    id: entry.id,
    description: entry.description,
    unit: entry.unit,
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.historicalPricing ? { defaultRate: entry.historicalPricing.average } : {}),
  }
}

export function verifyEstimateAiSuggestion(
  suggestion: EstimateAiSuggestion,
  catalog: EstimateAiCatalogEntry[],
): EstimateAiSuggestion {
  const matched = suggestion.stdId ? catalog.find((entry) => entry.id === suggestion.stdId) : undefined
  if (!matched) return { ...suggestion, stdId: undefined, source: 'manual' }
  return {
    ...suggestion,
    stdId: matched.id,
    description: matched.description,
    unit: matched.unit,
    source: 'catalog',
  }
}

export function buildEstimateAiManualFallback(reason = 'The AI provider is unavailable.'): EstimateAiResponse {
  return {
    fallback: true,
    assistantText: `${reason} Add a manual/new item below and verify its description, unit, quantity, and rate before saving.`,
    suggestions: [{
      description: 'Manual/new item — enter description',
      unit: '',
      quantity: 1,
      rate: 0,
      source: 'manual',
      reason: 'Manual/new item fallback. Verify the description, unit, quantity, and rate before adding it.',
    }],
  }
}

export function normalizeEstimateAiResponse(content: unknown, catalog: EstimateAiCatalogEntry[]): EstimateAiResponse {
  const parsed = parseModelPayload(content)
  if (!isRecord(parsed)) {
    return buildEstimateAiManualFallback('The AI response was not structured.')
  }

  const assistantText = [parsed.message, parsed.assistantText, parsed.text].find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim()
    || 'Here are suggestions for your review.'
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]))
  const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
  const suggestions: EstimateAiSuggestion[] = []

  for (const rawSuggestion of rawSuggestions.slice(0, 20)) {
    if (!isRecord(rawSuggestion)) continue
    const candidateId = typeof rawSuggestion.stdId === 'string' ? rawSuggestion.stdId.trim() : ''
    const matchedCatalog = candidateId ? catalogById.get(candidateId) : undefined
    const rawDescription = typeof rawSuggestion.description === 'string'
      ? rawSuggestion.description.trim()
      : typeof rawSuggestion.desc === 'string'
        ? rawSuggestion.desc.trim()
        : ''
    const description = matchedCatalog?.description || rawDescription
    if (!description) continue
    const unit = matchedCatalog?.unit || (typeof rawSuggestion.unit === 'string' ? rawSuggestion.unit.trim() : '')
    const quantity = suggestionNumber(rawSuggestion.quantity ?? rawSuggestion.qty, matchedCatalog?.defaultQty ?? 1)
    const rate = suggestionNumber(rawSuggestion.rate, matchedCatalog?.defaultRate ?? 0)
    const reason = typeof rawSuggestion.reason === 'string' && rawSuggestion.reason.trim()
      ? rawSuggestion.reason.trim()
      : matchedCatalog
        ? 'Matched to an active catalog entry; verify quantity and rate.'
        : 'New or unmatched item; verify description, unit, quantity, and rate.'

    suggestions.push({
      description,
      unit,
      quantity,
      rate,
      source: matchedCatalog ? 'catalog' : 'manual',
      reason,
      ...(matchedCatalog ? { stdId: matchedCatalog.id } : {}),
    })
  }

  if (suggestions.length === 0) return buildEstimateAiManualFallback('The AI response did not contain usable suggestions.')
  return { assistantText, suggestions }
}
