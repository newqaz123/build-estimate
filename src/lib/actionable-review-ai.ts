import {
  parseProposedCatalogMetadata,
  type DecimalString,
  type ProposedCatalogMetadata,
} from './actionable-review-types'
import {
  buildSourceSignature,
  isHashedCatalogMappingCacheKey,
  type CatalogMappingCache,
  type ApprovedCatalogMapping,
} from './catalog-mapping-cache'
import type { CatalogCandidateSnapshot } from './catalog-candidate-shortlist'
import type { ActionableReviewSettings } from './settings-schema'

export interface ActionableReviewAiConversionCandidate {
  ruleId: string
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: DecimalString
  scope: 'identity' | 'global' | 'catalog_item'
}

export interface ActionableReviewAiCatalogCandidate {
  catalogId: string
  description: string
  unit: string
  matchKind: CatalogCandidateSnapshot['matchKind']
  matchEvidence: string[]
  conversion?: ActionableReviewAiConversionCandidate
}

export interface ActionableReviewAiRequestRow {
  sourceRowId: string
  description: string
  unit: string
  structuralContext: string[]
  candidates: ActionableReviewAiCatalogCandidate[]
}

export interface ActionableReviewAiAdvice {
  sourceRowId: string
  decision: 'match' | 'create' | 'dismiss' | 'uncertain'
  catalogId?: string
  conversionRuleId?: string
  proposedCatalogMetadata?: ProposedCatalogMetadata
  confidence: number
  reason: string
}

export interface ActionableReviewAiBatchResult {
  advice: ActionableReviewAiAdvice[]
  cacheHitCount: number
  initialCallCount: 0 | 1
  escalationCallCount: 0 | 1
  estimatedCostMinor: number
  providerUnavailable: boolean
}

export type ActionableReviewProviderCall = (input: {
  model: string
  rows: readonly ActionableReviewAiRequestRow[]
  maxPromptTokens: number
}) => Promise<unknown>

export type ActionableReviewCostEstimator = (input: {
  model: string
  rows: readonly ActionableReviewAiRequestRow[]
  maxPromptTokens: number
}) => number

const MAX_CANDIDATES = 3
const MAX_REASON_LENGTH = 500
const MAX_EVIDENCE_ITEMS = 8
const MAX_EVIDENCE_LENGTH = 200
const MAX_CONTEXT_ITEMS = 12
const MAX_CONTEXT_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 400
const LOCAL_FALLBACK_REASON = 'local_manual_fallback'
const LOCAL_EXACT_REASON = 'deterministic_exact_match'
const LOCAL_CACHE_REASON = 'validated_mapping_cache'
const DUPLICATE_ROW_REASON = 'duplicate_source_row_id'

const ADVICE_KEYS = new Set([
  'sourceRowId',
  'decision',
  'catalogId',
  'conversionRuleId',
  'proposedCatalogMetadata',
  'confidence',
  'reason',
])

const FORBIDDEN_ADVICE_KEYS = new Set([
  'rate',
  'quantity',
  'total',
  'amount',
  'price',
  'conversionFactor',
  'catalogUnitsPerSourceUnit',
  'materialRate',
  'labourRate',
  'normalizedQuantity',
  'normalizedMaterialRate',
  'normalizedLabourRate',
  'normalizedTotal',
  'approvedBy',
  'approvedAt',
  'origin',
])

const RESPONSE_KEYS = new Set(['advice'])

const DECISIONS = new Set(['match', 'create', 'dismiss', 'uncertain'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function clampText(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max)
}

function closedCandidate(
  candidate: ActionableReviewAiCatalogCandidate,
): ActionableReviewAiCatalogCandidate {
  const closed: ActionableReviewAiCatalogCandidate = {
    catalogId: candidate.catalogId,
    description: clampText(candidate.description, MAX_DESCRIPTION_LENGTH),
    unit: clampText(candidate.unit, 64),
    matchKind: candidate.matchKind,
    matchEvidence: candidate.matchEvidence
      .slice(0, MAX_EVIDENCE_ITEMS)
      .map((item) => clampText(item, MAX_EVIDENCE_LENGTH)),
  }
  if (candidate.conversion) {
    closed.conversion = {
      ruleId: candidate.conversion.ruleId,
      sourceUnit: candidate.conversion.sourceUnit,
      catalogUnit: candidate.conversion.catalogUnit,
      catalogUnitsPerSourceUnit: candidate.conversion.catalogUnitsPerSourceUnit,
      scope: candidate.conversion.scope,
    }
  }
  return closed
}

/** Clamp only outbound provider payloads — never use for cache signature revalidation. */
function closedRequestRow(row: ActionableReviewAiRequestRow): ActionableReviewAiRequestRow {
  return {
    sourceRowId: row.sourceRowId,
    description: clampText(row.description, MAX_DESCRIPTION_LENGTH),
    unit: clampText(row.unit, 64),
    structuralContext: row.structuralContext
      .slice(0, MAX_CONTEXT_ITEMS)
      .map((item) => clampText(item, MAX_CONTEXT_LENGTH)),
    candidates: row.candidates.slice(0, MAX_CANDIDATES).map(closedCandidate),
  }
}

function localFallback(sourceRowId: string, reason = LOCAL_FALLBACK_REASON): ActionableReviewAiAdvice {
  return {
    sourceRowId,
    decision: 'uncertain',
    confidence: 0,
    reason,
  }
}

/**
 * Maps executor sourceRowId lookups onto precomputed Task 6 hashed cache keys.
 * Task 8 owns key computation from workspace/catalog/conversion/prompt/model fingerprints.
 * Fail-closed for missing or non-hashed mappings. Read-only — never writes.
 */
export function createActionableReviewRowCacheAdapter(input: {
  cache: CatalogMappingCache
  keysBySourceRowId: ReadonlyMap<string, string> | Readonly<Record<string, string>>
}): CatalogMappingCache {
  const keyLookup = input.keysBySourceRowId instanceof Map
    ? input.keysBySourceRowId
    : new Map(Object.entries(input.keysBySourceRowId))

  return {
    async get(sourceRowId: string): Promise<ApprovedCatalogMapping | null> {
      const hashedKey = keyLookup.get(sourceRowId)
      if (typeof hashedKey !== 'string' || !isHashedCatalogMappingCacheKey(hashedKey)) {
        return null
      }
      return input.cache.get(hashedKey)
    },
    async put(): Promise<void> {
      throw new Error('Actionable review row-cache adapter is read-only.')
    },
    async remove(): Promise<void> {
      throw new Error('Actionable review row-cache adapter is read-only.')
    },
  }
}

function isDeterministicExact(row: ActionableReviewAiRequestRow): ActionableReviewAiCatalogCandidate | null {
  if (row.candidates.length !== 1) return null
  const only = row.candidates[0]
  if (!only) return null
  if (only.matchKind === 'exact' || only.matchKind === 'approved_history') {
    return only
  }
  return null
}

/**
 * Match conversion rules are exact:
 * - candidate with conversion metadata requires that exact rule id
 * - candidate without conversion rejects any rule id
 */
function conversionMatches(
  candidate: ActionableReviewAiCatalogCandidate,
  conversionRuleId: string | undefined,
): boolean {
  const required = candidate.conversion?.ruleId
  if (required !== undefined) {
    return conversionRuleId === required
  }
  return conversionRuleId === undefined
}

function revalidateCachedMapping(
  row: ActionableReviewAiRequestRow,
  mapping: ApprovedCatalogMapping,
): ActionableReviewAiAdvice | null {
  // ORIGINAL unclamped description/unit — clamping is outbound-only.
  const rowSignature = buildSourceSignature({
    description: row.description,
    unit: row.unit,
  })
  if (mapping.sourceSignature !== rowSignature) return null

  const candidate = row.candidates.find((item) => item.catalogId === mapping.catalogId)
  if (!candidate) return null
  if (!conversionMatches(candidate, mapping.conversionRuleId)) return null

  const advice: ActionableReviewAiAdvice = {
    sourceRowId: row.sourceRowId,
    decision: 'match',
    catalogId: candidate.catalogId,
    confidence: 1,
    reason: LOCAL_CACHE_REASON,
  }
  if (mapping.conversionRuleId !== undefined) {
    advice.conversionRuleId = mapping.conversionRuleId
  }
  return advice
}

function exactLocalAdvice(
  row: ActionableReviewAiRequestRow,
  candidate: ActionableReviewAiCatalogCandidate,
): ActionableReviewAiAdvice {
  const advice: ActionableReviewAiAdvice = {
    sourceRowId: row.sourceRowId,
    decision: 'match',
    catalogId: candidate.catalogId,
    confidence: 1,
    reason: LOCAL_EXACT_REASON,
  }
  if (candidate.conversion?.ruleId) {
    advice.conversionRuleId = candidate.conversion.ruleId
  }
  return advice
}

function parseConfidence(value: unknown): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value)) return null
  if (value < 0 || value > 1) return null
  return value
}

function parseReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) return null
  return trimmed
}

function hasForbiddenKey(value: Record<string, unknown>): boolean {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_ADVICE_KEYS.has(key)) return true
  }
  return false
}

function parseOneAdvice(
  value: unknown,
  rowById: ReadonlyMap<string, ActionableReviewAiRequestRow>,
  seenIds: Set<string>,
): ActionableReviewAiAdvice | null {
  if (!isPlainRecord(value)) return null
  if (hasForbiddenKey(value)) return null
  for (const key of Object.keys(value)) {
    if (!ADVICE_KEYS.has(key)) return null
  }

  const sourceRowId = value.sourceRowId
  if (typeof sourceRowId !== 'string' || sourceRowId.trim() === '') return null
  if (seenIds.has(sourceRowId)) return null
  const row = rowById.get(sourceRowId)
  if (!row) return null

  const decision = value.decision
  if (typeof decision !== 'string' || !DECISIONS.has(decision)) return null

  const confidence = parseConfidence(value.confidence)
  if (confidence === null) return null
  const reason = parseReason(value.reason)
  if (reason === null) return null

  const catalogId = value.catalogId
  const conversionRuleId = value.conversionRuleId
  const hasCatalogId = catalogId !== undefined
  const hasConversionRuleId = conversionRuleId !== undefined
  const hasProposed = value.proposedCatalogMetadata !== undefined

  if (hasCatalogId && (typeof catalogId !== 'string' || catalogId.trim() === '')) return null
  if (hasConversionRuleId && (typeof conversionRuleId !== 'string' || conversionRuleId.trim() === '')) {
    return null
  }

  let proposedCatalogMetadata: ProposedCatalogMetadata | undefined
  if (hasProposed) {
    try {
      proposedCatalogMetadata = parseProposedCatalogMetadata(value.proposedCatalogMetadata)
    } catch {
      return null
    }
    if (proposedCatalogMetadata.description.length > MAX_DESCRIPTION_LENGTH) return null
    if (proposedCatalogMetadata.unit.length > 64) return null
    if (proposedCatalogMetadata.aliases.length > 20) return null
    if (proposedCatalogMetadata.aliases.some((alias) => alias.length > MAX_EVIDENCE_LENGTH)) return null
  }

  if (decision === 'match') {
    if (!hasCatalogId || hasProposed) return null
    const candidate = row.candidates.find((item) => item.catalogId === catalogId)
    if (!candidate) return null
    const selectedRule = hasConversionRuleId ? (conversionRuleId as string) : undefined
    if (!conversionMatches(candidate, selectedRule)) return null
    const advice: ActionableReviewAiAdvice = {
      sourceRowId,
      decision: 'match',
      catalogId: catalogId as string,
      confidence,
      reason,
    }
    if (selectedRule !== undefined) {
      advice.conversionRuleId = selectedRule
    }
    seenIds.add(sourceRowId)
    return advice
  }

  if (decision === 'create') {
    if (hasCatalogId || hasConversionRuleId || !hasProposed || !proposedCatalogMetadata) return null
    seenIds.add(sourceRowId)
    return {
      sourceRowId,
      decision: 'create',
      proposedCatalogMetadata,
      confidence,
      reason,
    }
  }

  // dismiss | uncertain — identity-only advice
  if (hasCatalogId || hasConversionRuleId || hasProposed) return null
  seenIds.add(sourceRowId)
  return {
    sourceRowId,
    decision: decision as 'dismiss' | 'uncertain',
    confidence,
    reason,
  }
}

/**
 * Fail-closed parse of a provider payload against the closed request allowlists.
 * Returns null when the top-level envelope is unusable.
 */
export function parseActionableReviewAiProviderResponse(
  value: unknown,
  rows: readonly ActionableReviewAiRequestRow[],
): { advice: ActionableReviewAiAdvice[]; complete: boolean } | null {
  if (!isPlainRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (!RESPONSE_KEYS.has(key)) return null
  }
  if (!Array.isArray(value.advice)) return null

  const rowById = new Map(rows.map((row) => [row.sourceRowId, row]))
  const seenIds = new Set<string>()
  const parsed: ActionableReviewAiAdvice[] = []

  for (const entry of value.advice) {
    const advice = parseOneAdvice(entry, rowById, seenIds)
    if (!advice) {
      return null
    }
    parsed.push(advice)
  }

  const complete = rows.every((row) => seenIds.has(row.sourceRowId))
  return { advice: parsed, complete }
}

function providerEnabled(settings: ActionableReviewSettings): boolean {
  if (settings.stage === 'off') return false
  if (typeof settings.lowCostModel !== 'string' || settings.lowCostModel.trim() === '') {
    return false
  }
  return true
}

function mergeAdviceByRowId(
  base: ActionableReviewAiAdvice[],
  overlay: ActionableReviewAiAdvice[],
): ActionableReviewAiAdvice[] {
  const map = new Map(base.map((item) => [item.sourceRowId, item]))
  for (const item of overlay) {
    map.set(item.sourceRowId, item)
  }
  return base.map((item) => map.get(item.sourceRowId) ?? item)
}

function collectUniqueRows(rows: readonly ActionableReviewAiRequestRow[]): {
  unique: ActionableReviewAiRequestRow[]
  hasDuplicates: boolean
} {
  const seen = new Set<string>()
  const unique: ActionableReviewAiRequestRow[] = []
  let hasDuplicates = false
  for (const row of rows) {
    if (seen.has(row.sourceRowId)) {
      hasDuplicates = true
      continue
    }
    seen.add(row.sourceRowId)
    unique.push(row)
  }
  return { unique, hasDuplicates }
}

async function invokeProvider(input: {
  model: string
  rows: readonly ActionableReviewAiRequestRow[]
  settings: ActionableReviewSettings
  callProvider: ActionableReviewProviderCall
  estimateCostMinor: ActionableReviewCostEstimator
  remainingBudget: number
}): Promise<{
  advice: ActionableReviewAiAdvice[]
  called: boolean
  estimatedCostMinor: number
  providerUnavailable: boolean
  remainingBudget: number
}> {
  // Clamp only the outbound payload; parse allowlists use the same closed snapshot.
  const closedRows = input.rows.map(closedRequestRow)
  const fallback = closedRows.map((row) => localFallback(row.sourceRowId))

  if (input.remainingBudget <= 0) {
    return {
      advice: fallback,
      called: false,
      estimatedCostMinor: 0,
      providerUnavailable: false,
      remainingBudget: input.remainingBudget,
    }
  }

  const estimateInput = {
    model: input.model,
    rows: closedRows,
    maxPromptTokens: input.settings.maxPromptTokens,
  }

  let estimated: number
  try {
    estimated = input.estimateCostMinor(estimateInput)
  } catch {
    return {
      advice: fallback,
      called: false,
      estimatedCostMinor: 0,
      providerUnavailable: false,
      remainingBudget: input.remainingBudget,
    }
  }

  if (!Number.isFinite(estimated) || estimated < 0 || estimated > input.remainingBudget) {
    return {
      advice: fallback,
      called: false,
      estimatedCostMinor: 0,
      providerUnavailable: false,
      remainingBudget: input.remainingBudget,
    }
  }

  try {
    const raw = await input.callProvider(estimateInput)
    const parsed = parseActionableReviewAiProviderResponse(raw, closedRows)
    if (!parsed) {
      return {
        advice: fallback,
        called: true,
        estimatedCostMinor: estimated,
        providerUnavailable: true,
        remainingBudget: input.remainingBudget - estimated,
      }
    }

    const byId = new Map(parsed.advice.map((item) => [item.sourceRowId, item]))
    const advice = closedRows.map((row) => byId.get(row.sourceRowId) ?? localFallback(row.sourceRowId))
    const missing = closedRows.some((row) => !byId.has(row.sourceRowId))
    return {
      advice,
      called: true,
      estimatedCostMinor: estimated,
      providerUnavailable: missing || !parsed.complete,
      remainingBudget: input.remainingBudget - estimated,
    }
  } catch {
    return {
      advice: fallback,
      called: true,
      estimatedCostMinor: estimated,
      providerUnavailable: true,
      remainingBudget: input.remainingBudget - estimated,
    }
  }
}

export async function executeActionableReviewAiBatch(input: {
  rows: readonly ActionableReviewAiRequestRow[]
  settings: ActionableReviewSettings
  callProvider: ActionableReviewProviderCall
  estimateCostMinor: ActionableReviewCostEstimator
  cache: CatalogMappingCache
}): Promise<ActionableReviewAiBatchResult> {
  // Keep ORIGINAL rows for cache signature / local decisions; clamp only on provider send.
  const limitedRows = input.rows.slice(0, Math.max(0, input.settings.maxRows))
  const { unique, hasDuplicates } = collectUniqueRows(limitedRows)

  if (hasDuplicates) {
    return {
      advice: unique.map((row) => localFallback(row.sourceRowId, DUPLICATE_ROW_REASON)),
      cacheHitCount: 0,
      initialCallCount: 0,
      escalationCallCount: 0,
      estimatedCostMinor: 0,
      providerUnavailable: false,
    }
  }

  const adviceById = new Map<string, ActionableReviewAiAdvice>()
  const pending: ActionableReviewAiRequestRow[] = []
  let cacheHitCount = 0

  for (const row of unique) {
    const cached = await input.cache.get(row.sourceRowId)
    if (cached) {
      const validated = revalidateCachedMapping(row, cached)
      if (validated) {
        adviceById.set(row.sourceRowId, validated)
        cacheHitCount += 1
        continue
      }
    }

    const exact = isDeterministicExact(row)
    if (exact) {
      adviceById.set(row.sourceRowId, exactLocalAdvice(row, exact))
      continue
    }

    pending.push(row)
  }

  let initialCallCount: 0 | 1 = 0
  let escalationCallCount: 0 | 1 = 0
  let estimatedCostMinor = 0
  let providerUnavailable = false
  let remainingBudget = input.settings.maxEstimatedCostMinor

  if (pending.length === 0) {
    return {
      advice: unique.map((row) => adviceById.get(row.sourceRowId) ?? localFallback(row.sourceRowId)),
      cacheHitCount,
      initialCallCount,
      escalationCallCount,
      estimatedCostMinor,
      providerUnavailable,
    }
  }

  if (!providerEnabled(input.settings) || remainingBudget <= 0) {
    for (const row of pending) {
      adviceById.set(row.sourceRowId, localFallback(row.sourceRowId))
    }
    return {
      advice: unique.map((row) => adviceById.get(row.sourceRowId) ?? localFallback(row.sourceRowId)),
      cacheHitCount,
      initialCallCount: 0,
      escalationCallCount: 0,
      estimatedCostMinor: 0,
      providerUnavailable: !providerEnabled(input.settings),
    }
  }

  const initialModel = input.settings.lowCostModel!.trim()
  const initial = await invokeProvider({
    model: initialModel,
    rows: pending,
    settings: input.settings,
    callProvider: input.callProvider,
    estimateCostMinor: input.estimateCostMinor,
    remainingBudget,
  })

  if (initial.called) initialCallCount = 1
  estimatedCostMinor += initial.estimatedCostMinor
  remainingBudget = initial.remainingBudget
  if (initial.providerUnavailable) providerUnavailable = true

  for (const item of initial.advice) {
    adviceById.set(item.sourceRowId, item)
  }

  if (!initial.called) {
    for (const row of pending) {
      if (!adviceById.has(row.sourceRowId)) {
        adviceById.set(row.sourceRowId, localFallback(row.sourceRowId))
      }
    }
  }

  // Paid escalation only after a usable initial response. Throw/malformed/incomplete
  // sets providerUnavailable and must not trigger a second paid call.
  const uncertainRows = pending.filter((row) => {
    const advice = adviceById.get(row.sourceRowId)
    return advice?.decision === 'uncertain'
  })

  const escalationModel = input.settings.escalationModel?.trim()
  if (
    !providerUnavailable
    && input.settings.escalationEnabled
    && uncertainRows.length > 0
    && escalationModel
    && remainingBudget > 0
  ) {
    const escalated = await invokeProvider({
      model: escalationModel,
      rows: uncertainRows,
      settings: input.settings,
      callProvider: input.callProvider,
      estimateCostMinor: input.estimateCostMinor,
      remainingBudget,
    })

    if (escalated.called) {
      escalationCallCount = 1
      estimatedCostMinor += escalated.estimatedCostMinor
      remainingBudget = escalated.remainingBudget
      if (escalated.providerUnavailable) providerUnavailable = true

      const merged = mergeAdviceByRowId(
        uncertainRows.map((row) => adviceById.get(row.sourceRowId) ?? localFallback(row.sourceRowId)),
        escalated.advice,
      )
      for (const item of merged) {
        adviceById.set(item.sourceRowId, item)
      }
    }
  }

  return {
    advice: unique.map((row) => adviceById.get(row.sourceRowId) ?? localFallback(row.sourceRowId)),
    cacheHitCount,
    initialCallCount,
    escalationCallCount,
    estimatedCostMinor,
    providerUnavailable,
  }
}
