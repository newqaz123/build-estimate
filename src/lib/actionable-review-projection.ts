import { createHash } from 'node:crypto'
import {
  createActionableReviewRowCacheAdapter,
  executeActionableReviewAiBatch,
  type ActionableReviewAiAdvice,
  type ActionableReviewAiBatchResult,
  type ActionableReviewAiCatalogCandidate,
  type ActionableReviewAiConversionCandidate,
  type ActionableReviewAiRequestRow,
  type ActionableReviewCostEstimator,
  type ActionableReviewProviderCall,
} from './actionable-review-ai'
import type {
  DecimalString,
  ExtractedPricingSnapshot,
  PricingNormalization,
  RowRole,
  SuggestionVersions,
} from './actionable-review-types'
import type { ExtractionProposalAudit } from './boq-extraction-acceptance'
import {
  extractionRunIdentityFingerprint,
  stableCanonicalJson,
  type BoqExtractionRun,
} from './boq-extraction-run'
import type { BoqSourceRowV3, DoclingRawCellV3 } from './boq-extraction-schema'
import type { SourceCellMapping, SourceCellRef } from './boq-extraction-cell-mapping'
import {
  fingerprintCanonicalSections,
  type ValidatedProposal,
} from './boq-extraction-proposals'
import type { Boq, BoqSourceRef } from './boq-schema'
import {
  classifySourceRows,
  type RowRoleFinding,
} from './boq-row-role-classifier'
import {
  reconcileRepresentedRows,
  type RepresentedRowFinding,
} from './boq-represented-row-reconciliation'
import {
  shortlistCatalogCandidates,
  type CatalogCandidateSnapshot,
  type CatalogShortlistCatalogEntry,
} from './catalog-candidate-shortlist'
import {
  identityConversionRule,
  normalizePricingWithRule,
  type HumanApprovedCatalogConversionRule,
} from './catalog-conversion'
import {
  buildCatalogFingerprint,
  buildCatalogMappingCacheKey,
  buildConversionFingerprint,
  buildScopedSourceSignature,
  buildSourceSignature,
  type ApprovedCatalogMapping,
  type CatalogMappingCache,
} from './catalog-mapping-cache'
import {
  addDecimal,
  parseDecimalString,
  type DecimalString as DecimalStringValue,
} from './decimal-string'
import { canonicalUnit } from './standard-matching'
import type { ActionableReviewSettings } from './settings-schema'
import { buildActionableReviewMetrics, type ActionableReviewMetrics } from './actionable-review-metrics'

/** Closed prompt contract version included in fingerprints and cache keys. */
export const ACTIONABLE_REVIEW_PROMPT_VERSION = 'actionable-review-ai-v1'

const HARD_ROW_CAP = 100
const ACTIONABLE_ROLES = new Set<RowRole>(['priced_item', 'uncertain'])

export interface ActionableItemSuggestion {
  id: string
  extractionRunId: string
  sourceRowIds: string[]
  sourceRefs: BoqSourceRef[]
  sourceCellMapping?: SourceCellMapping
  rowRole: RowRole
  deterministicReasons: string[]
  suggestedSectionIndex: number
  extractedItem: ExtractedPricingSnapshot
  catalogCandidates: CatalogCandidateSnapshot[]
  aiAdvice?: ActionableReviewAiAdvice
  normalization?: PricingNormalization
  status: 'pending' | 'added_matched' | 'added_pending_catalog' | 'dismissed' | 'stale'
  versions: SuggestionVersions
}

export interface ActionableReviewValidationSummary {
  rawRowCount: number
  actionableCount: number
  dismissedCount: number
  representedCount: number
  locallyPreparedCatalogCount: number
  aiReviewedCount: number
  sourceTotalDifference: DecimalString | null
  rejectedReasonCounts: Record<string, number>
}

export interface ActionableReview {
  id: string
  extractionRunId: string
  actionableItemSuggestions: ActionableItemSuggestion[]
  dismissedEvidence: RowRoleFinding[]
  representedRows: RepresentedRowFinding[]
  validationSummary: ActionableReviewValidationSummary
  versions: SuggestionVersions
  generatedAt: string
  mode: 'shadow' | 'focused'
}

export interface GenerateActionableReviewInput {
  extractionRunId: string
  run: BoqExtractionRun
  sourceRows: readonly BoqSourceRowV3[]
  boq: Boq
  /** Accepted for contract compatibility; never used for grouping/cardinality. */
  proposals: readonly ValidatedProposal[]
  audits: readonly ExtractionProposalAudit[]
  catalog: readonly CatalogShortlistCatalogEntry[]
  conversionRules: readonly HumanApprovedCatalogConversionRule[]
  unitMap: Record<string, string>
  settings: ActionableReviewSettings
  workspaceScope?: string
  promptVersion?: string
  modelVersion?: string
  cache: CatalogMappingCache
  callProvider: ActionableReviewProviderCall
  estimateCostMinor: ActionableReviewCostEstimator
  now?: () => string
  currencyScale?: number
  mode?: 'shadow' | 'focused'
}

export interface GenerateActionableReviewResult {
  review: ActionableReview
  metrics: ActionableReviewMetrics
  aiBatch: ActionableReviewAiBatchResult
  cacheKeysBySourceRowId: Record<string, string>
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableCanonicalJson(value)).digest('hex')}`
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

const STRICT_AMOUNT =
  /^(?:([A-Z]{3}|[$£¥฿€])\s*)?(\()?((?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)(\))?(?:\s*([A-Z]{3}))?$/

function parseAmountCell(text: string): DecimalStringValue | null {
  const match = STRICT_AMOUNT.exec(text.trim())
  if (!match) return null
  if (
    (match[1] !== undefined && match[5] !== undefined)
    || Boolean(match[2]) !== Boolean(match[4])
  ) {
    return null
  }
  if (match[2]) return null
  try {
    return parseDecimalString(match[3]!.replaceAll(',', ''))
  } catch {
    return null
  }
}

function decimalFromFiniteNumber(value: number): DecimalStringValue | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (Object.is(value, -0) || value === 0) return '0'
  const text = value.toString().toLowerCase()
  if (text.includes('e')) return null
  try {
    return parseDecimalString(text)
  } catch {
    return null
  }
}

function anchorCells(row: BoqSourceRowV3): DoclingRawCellV3[] {
  return row.rawCells.filter((cell) => !cell.carried)
}

function textAtColumn(row: BoqSourceRowV3, column: number): string {
  for (const cell of anchorCells(row)) {
    if (cell.column === column || cell.startColumnOffset === column) {
      return cell.rawText.trim()
    }
  }
  return ''
}

function headerIndex(
  headers: readonly string[],
  predicate: (normalized: string) => boolean,
): number {
  return headers.findIndex((header) => predicate(normalizeLabel(header)))
}

interface ExtractedRowEvidence {
  extractedItem: ExtractedPricingSnapshot
  sourceCellMapping: SourceCellMapping
  sourceRef: BoqSourceRef
  description: string
  unit: string
}

function extractRowEvidence(row: BoqSourceRowV3): ExtractedRowEvidence {
  const headers = row.headers
  const descIdx = headerIndex(
    headers,
    (header) =>
      header === 'description'
      || header === 'description of works'
      || header === 'particulars'
      || header === 'item description'
      || header === 'work description'
      || header === 'item',
  )
  const unitIdx = headerIndex(
    headers,
    (header) =>
      header === 'unit'
      || header === 'uom'
      || header === 'unit of measure'
      || header.includes('unit'),
  )
  const qtyIdx = headerIndex(
    headers,
    (header) =>
      header === 'qty'
      || header === 'q ty'
      || header === 'quantity'
      || header === 'quant',
  )
  const rateIdx = headerIndex(
    headers,
    (header) =>
      header === 'rate'
      || header === 'unit rate'
      || header === 'price'
      || header === 'unit price',
  )
  const amountIdx = headerIndex(
    headers,
    (header) =>
      header === 'amount'
      || header === 'total'
      || header === 'total amount'
      || header === 'extended amount'
      || header === 'value',
  )
  const materialRateIdx = headerIndex(
    headers,
    (header) => header === 'material rate' || header === 'mat rate',
  )
  const labourRateIdx = headerIndex(
    headers,
    (header) => header === 'labour rate' || header === 'labor rate',
  )

  const description = (descIdx >= 0 ? textAtColumn(row, descIdx) : textAtColumn(row, 0)).trim()
  const unitText = unitIdx >= 0 ? textAtColumn(row, unitIdx).trim() : ''
  const unit = unitText && parseAmountCell(unitText) === null ? unitText : ''
  const quantity = qtyIdx >= 0 ? parseAmountCell(textAtColumn(row, qtyIdx)) : null
  const combinedRate = rateIdx >= 0 ? parseAmountCell(textAtColumn(row, rateIdx)) : null
  const materialRate = materialRateIdx >= 0
    ? parseAmountCell(textAtColumn(row, materialRateIdx))
    : combinedRate
  const labourRate = labourRateIdx >= 0
    ? parseAmountCell(textAtColumn(row, labourRateIdx))
    : null
  const total = amountIdx >= 0 ? parseAmountCell(textAtColumn(row, amountIdx)) : null

  const mapping: SourceCellMapping = {
    sourceRowIds: [row.id],
  }
  if (descIdx >= 0) {
    mapping.description = [{ sourceRowId: row.id, column: descIdx } satisfies SourceCellRef]
  }
  if (unitIdx >= 0) mapping.unit = { sourceRowId: row.id, column: unitIdx }
  if (qtyIdx >= 0) mapping.quantity = { sourceRowId: row.id, column: qtyIdx }
  if (rateIdx >= 0) mapping.rate = { sourceRowId: row.id, column: rateIdx }
  if (amountIdx >= 0) mapping.total = { sourceRowId: row.id, column: amountIdx }
  if (materialRateIdx >= 0) {
    mapping.materialRate = { sourceRowId: row.id, column: materialRateIdx }
  }
  if (labourRateIdx >= 0) {
    mapping.labourRate = { sourceRowId: row.id, column: labourRateIdx }
  }

  return {
    description,
    unit,
    extractedItem: {
      description,
      unit,
      quantity: quantity ?? '0',
      materialRate: materialRate ?? '0',
      labourRate: labourRate ?? '0',
      total: total ?? '0',
    },
    sourceCellMapping: mapping,
    sourceRef: { page: row.page, table: row.table, row: row.row },
  }
}

function suggestedSectionIndex(boq: Boq, row: BoqSourceRowV3): number {
  const sectionName = (row.section ?? '').trim().toLowerCase()
  if (!sectionName) return 0
  const index = boq.sections.findIndex(
    (section) => section.header.trim().toLowerCase() === sectionName,
  )
  return index >= 0 ? index : 0
}

function sumDecimals(values: readonly DecimalStringValue[]): DecimalStringValue {
  return values.reduce<DecimalStringValue>((sum, value) => addDecimal(sum, value), '0')
}

function boqPricedTotals(boq: Boq): DecimalStringValue {
  const totals: DecimalStringValue[] = []
  for (const section of boq.sections) {
    for (const item of section.items) {
      if (
        item.pricingRole !== 'bundle_child'
        && typeof (item as { total?: unknown }).total === 'number'
      ) {
        const total = decimalFromFiniteNumber((item as { total: number }).total)
        if (total !== null) totals.push(total)
      }
    }
  }
  return sumDecimals(totals)
}

function sourceDocumentTotal(run: BoqExtractionRun, boq: Boq): DecimalStringValue | null {
  if (run.reconciliation.sourceTotal !== null && run.reconciliation.sourceTotal !== undefined) {
    return decimalFromFiniteNumber(run.reconciliation.sourceTotal)
  }
  if (typeof boq.sourceTotal === 'number') {
    return decimalFromFiniteNumber(boq.sourceTotal)
  }
  return null
}

function subtractDecimal(left: DecimalStringValue, right: DecimalStringValue): DecimalStringValue {
  return addDecimal(left, addDecimal('0', multiplyNegative(right)))
}

function multiplyNegative(value: DecimalStringValue): DecimalStringValue {
  if (value === '0') return '0'
  return value.startsWith('-') ? value.slice(1) : `-${value}`
}

function buildVersions(input: {
  run: BoqExtractionRun
  boq: Boq
  catalog: readonly CatalogShortlistCatalogEntry[]
  conversionRules: readonly HumanApprovedCatalogConversionRule[]
  promptVersion: string
  modelVersion?: string
}): SuggestionVersions {
  const versions: SuggestionVersions = {
    extractionFingerprint: extractionRunIdentityFingerprint(input.run),
    boqSectionsFingerprint: fingerprintCanonicalSections(input.boq.sections),
    catalogFingerprint: buildCatalogFingerprint(input.catalog),
    conversionFingerprint: buildConversionFingerprint(input.conversionRules),
    promptVersion: input.promptVersion,
  }
  if (nonBlank(input.modelVersion)) {
    versions.modelVersion = input.modelVersion
  }
  return versions
}

function buildSuggestionId(input: {
  extractionRunId: string
  sourceRowIds: readonly string[]
  versions: SuggestionVersions
}): string {
  return digest({
    kind: 'actionable-item-suggestion',
    extractionRunId: input.extractionRunId,
    sourceRowIds: [...input.sourceRowIds],
    versions: input.versions,
  })
}

export function buildActionableReviewFingerprint(
  review: Pick<ActionableReview, 'extractionRunId' | 'versions' | 'actionableItemSuggestions' | 'dismissedEvidence' | 'representedRows' | 'mode'>,
): string {
  return digest({
    kind: 'actionable-review',
    extractionRunId: review.extractionRunId,
    mode: review.mode,
    versions: review.versions,
    suggestionIds: review.actionableItemSuggestions.map((item) => item.id),
    dismissed: review.dismissedEvidence.map((item) => ({
      sourceRowId: item.sourceRowId,
      role: item.role,
      reasonCodes: item.reasonCodes,
    })),
    represented: review.representedRows.map((item) => ({
      sourceRowIds: item.sourceRowIds,
      boqItemId: item.boqItemId,
      reason: item.reason,
    })),
  })
}

function toAiCandidate(
  candidate: CatalogCandidateSnapshot,
  rulesById: ReadonlyMap<string, HumanApprovedCatalogConversionRule>,
): ActionableReviewAiCatalogCandidate {
  const closed: ActionableReviewAiCatalogCandidate = {
    catalogId: candidate.catalogId,
    description: candidate.description,
    unit: candidate.unit,
    matchKind: candidate.matchKind,
    matchEvidence: [`matchKind:${candidate.matchKind}`, `score:${candidate.score}`],
  }
  if (candidate.conversionRuleId) {
    const rule = rulesById.get(candidate.conversionRuleId)
    if (rule) {
      const conversion: ActionableReviewAiConversionCandidate = {
        ruleId: rule.id,
        sourceUnit: rule.sourceUnit,
        catalogUnit: rule.catalogUnit,
        catalogUnitsPerSourceUnit: rule.catalogUnitsPerSourceUnit,
        scope: rule.scope,
      }
      closed.conversion = conversion
    }
  }
  return closed
}

function tryNormalization(input: {
  extracted: ExtractedPricingSnapshot
  advice: ActionableReviewAiAdvice | undefined
  candidates: readonly CatalogCandidateSnapshot[]
  rulesById: ReadonlyMap<string, HumanApprovedCatalogConversionRule>
  unitMap: Record<string, string>
  currencyScale: number
  now: string
}): PricingNormalization | undefined {
  if (!input.advice || input.advice.decision !== 'match' || !input.advice.catalogId) {
    return undefined
  }
  const candidate = input.candidates.find((entry) => entry.catalogId === input.advice!.catalogId)
  if (!candidate) return undefined

  const sourceUnit = input.extracted.unit
  const catalogUnit = candidate.unit
  const sourceCanonical = canonicalUnit(sourceUnit, input.unitMap)
  const catalogCanonical = canonicalUnit(catalogUnit, input.unitMap)

  const rule = input.advice.conversionRuleId
    ? input.rulesById.get(input.advice.conversionRuleId)
    : undefined

  if (!rule && sourceCanonical === catalogCanonical && sourceCanonical !== '') {
    // Identity only when units already agree canonically.
    // Canonicalize the source unit for the rule path; extracted snapshot stays raw.
    const identity = identityConversionRule(sourceCanonical)
    try {
      return normalizePricingWithRule({
        source: {
          ...input.extracted,
          unit: sourceCanonical,
          confirmedAt: input.now,
          confirmedBy: 'shadow-projection',
        },
        catalogId: candidate.catalogId,
        catalogDescription: candidate.description,
        catalogUnit: catalogCanonical,
        rule: identity,
        currencyScale: input.currencyScale,
      })
    } catch {
      return undefined
    }
  }

  if (!rule) return undefined
  try {
    return normalizePricingWithRule({
      source: {
        ...input.extracted,
        confirmedAt: input.now,
        confirmedBy: 'shadow-projection',
      },
      catalogId: candidate.catalogId,
      catalogDescription: candidate.description,
      catalogUnit: candidate.unit,
      rule,
      currencyScale: input.currencyScale,
    })
  } catch {
    return undefined
  }
}

/**
 * Build a stable actionable-review projection independent of provider proposal
 * cardinality/grouping. Uses Tasks 2–7 only; never trusts proposal/model money.
 */
export async function generateActionableReview(
  input: GenerateActionableReviewInput,
): Promise<GenerateActionableReviewResult> {
  const mode = input.mode ?? 'shadow'
  const now = input.now?.() ?? new Date().toISOString()
  const currencyScale = input.currencyScale ?? 2
  const promptVersion = nonBlank(input.promptVersion)
    ? input.promptVersion
    : ACTIONABLE_REVIEW_PROMPT_VERSION
  const modelVersion = nonBlank(input.modelVersion)
    ? input.modelVersion
    : (nonBlank(input.settings.lowCostModel) ? input.settings.lowCostModel : undefined)
  const workspaceScope = input.workspaceScope?.trim() ?? ''
  const rowLimit = Math.min(HARD_ROW_CAP, Math.max(0, input.settings.maxRows))
  // Cap before classification so identical prefixes remain stable.
  const sourceRows = input.sourceRows.slice(0, rowLimit)
  void input.proposals

  const versions = buildVersions({
    run: input.run,
    boq: input.boq,
    catalog: input.catalog,
    conversionRules: input.conversionRules,
    promptVersion,
    modelVersion,
  })

  const roles = classifySourceRows({
    run: input.run,
    sourceRows,
  })

  const representedRows = reconcileRepresentedRows({
    boq: input.boq,
    sourceRows,
    proposals: input.proposals,
    audits: input.audits,
    roles,
    unitMap: input.unitMap,
  })
  const representedIds = new Set(
    representedRows.flatMap((entry) => entry.sourceRowIds),
  )

  const dismissedEvidence = roles.filter((finding) => {
    if (representedIds.has(finding.sourceRowId)) return false
    return !ACTIONABLE_ROLES.has(finding.role)
  })

  const actionableFindings = roles.filter((finding) => {
    if (representedIds.has(finding.sourceRowId)) return false
    return ACTIONABLE_ROLES.has(finding.role)
  })

  const rowsById = new Map(sourceRows.map((row) => [row.id, row]))
  const rulesById = new Map(input.conversionRules.map((rule) => [rule.id, rule]))
  const rejectedReasonCounts: Record<string, number> = {}

  type PreparedRow = {
    finding: RowRoleFinding
    row: BoqSourceRowV3
    evidence: ExtractedRowEvidence
    candidates: CatalogCandidateSnapshot[]
    sourceSignature: string
    cacheKey: string
    aiRequest: ActionableReviewAiRequestRow
  }

  const prepared: PreparedRow[] = []
  const cacheKeysBySourceRowId: Record<string, string> = {}

  for (const finding of actionableFindings) {
    const row = rowsById.get(finding.sourceRowId)
    if (!row) continue
    const evidence = extractRowEvidence(row)
    // Mapping/shortlist/AI revalidation: description+unit only.
    const sourceSignature = buildSourceSignature({
      description: evidence.description,
      unit: evidence.unit,
    })
    // Task 6 hashed key: scope + unitMap live only in the scoped signature input.
    const scopedSourceSignature = buildScopedSourceSignature({
      description: evidence.description,
      unit: evidence.unit,
      unitMap: input.unitMap,
      workspaceScope,
    })
    const cacheKey = buildCatalogMappingCacheKey({
      sourceSignature: scopedSourceSignature,
      workspaceScope,
      catalogFingerprint: versions.catalogFingerprint,
      conversionFingerprint: versions.conversionFingerprint,
      promptVersion,
      modelVersion,
    })
    cacheKeysBySourceRowId[finding.sourceRowId] = cacheKey

    let cachedMapping: ApprovedCatalogMapping | null = null
    try {
      cachedMapping = await input.cache.get(cacheKey)
    } catch {
      cachedMapping = null
    }

    const candidates = shortlistCatalogCandidates({
      description: evidence.description,
      unit: evidence.unit,
      catalog: input.catalog,
      unitMap: input.unitMap,
      conversionRules: input.conversionRules,
      approvedMappings: cachedMapping ? [cachedMapping] : [],
      sourceSignature,
    })

    prepared.push({
      finding,
      row,
      evidence,
      candidates,
      sourceSignature,
      cacheKey,
      aiRequest: {
        sourceRowId: finding.sourceRowId,
        description: evidence.description,
        unit: evidence.unit,
        structuralContext: [
          `section:${row.section ?? ''}`,
          `role:${finding.role}`,
          ...finding.reasonCodes.map((code) => `reason:${code}`),
        ],
        candidates: candidates.map((candidate) => toAiCandidate(candidate, rulesById)),
      },
    })
  }

  const rowCache = createActionableReviewRowCacheAdapter({
    cache: input.cache,
    keysBySourceRowId: cacheKeysBySourceRowId,
  })

  let aiBatch: ActionableReviewAiBatchResult
  try {
    aiBatch = await executeActionableReviewAiBatch({
      rows: prepared.map((entry) => entry.aiRequest),
      settings: input.settings,
      callProvider: input.callProvider,
      estimateCostMinor: input.estimateCostMinor,
      cache: rowCache,
    })
  } catch {
    aiBatch = {
      advice: prepared.map((entry) => ({
        sourceRowId: entry.finding.sourceRowId,
        decision: 'uncertain',
        confidence: 0,
        reason: 'local_manual_fallback',
      })),
      cacheHitCount: 0,
      initialCallCount: 0,
      escalationCallCount: 0,
      estimatedCostMinor: 0,
      providerUnavailable: true,
    }
  }

  const adviceById = new Map(aiBatch.advice.map((entry) => [entry.sourceRowId, entry]))
  const suggestions: ActionableItemSuggestion[] = []

  for (const entry of prepared) {
    const advice = adviceById.get(entry.finding.sourceRowId)
    const normalization = tryNormalization({
      extracted: entry.evidence.extractedItem,
      advice,
      candidates: entry.candidates,
      rulesById,
      unitMap: input.unitMap,
      currencyScale,
      now,
    })

    // Model advice is never cached as an approved mapping: only the user's
    // Approve may write approved history (see catalog-mapping-cache-storage).

    const suggestion: ActionableItemSuggestion = {
      id: buildSuggestionId({
        extractionRunId: input.extractionRunId,
        sourceRowIds: [entry.finding.sourceRowId],
        versions,
      }),
      extractionRunId: input.extractionRunId,
      sourceRowIds: [entry.finding.sourceRowId],
      sourceRefs: [entry.evidence.sourceRef],
      sourceCellMapping: entry.evidence.sourceCellMapping,
      rowRole: entry.finding.role,
      deterministicReasons: [...entry.finding.reasonCodes],
      suggestedSectionIndex: suggestedSectionIndex(input.boq, entry.row),
      extractedItem: entry.evidence.extractedItem,
      catalogCandidates: entry.candidates,
      status: 'pending',
      versions: { ...versions },
    }
    if (advice) suggestion.aiAdvice = advice
    if (normalization) suggestion.normalization = normalization
    suggestions.push(suggestion)
  }

  const sourceTotal = sourceDocumentTotal(input.run, input.boq)
  const actionableTotals = sumDecimals(
    suggestions.map((item) => item.extractedItem.total),
  )
  const projectedTotal = addDecimal(boqPricedTotals(input.boq), actionableTotals)
  const sourceTotalDifference = sourceTotal === null
    ? null
    : subtractDecimal(projectedTotal, sourceTotal)

  const locallyPreparedCatalogCount = suggestions.filter((item) => {
    if (item.catalogCandidates.length === 0) return false
    const only = item.catalogCandidates[0]
    return item.catalogCandidates.length === 1
      && (only?.matchKind === 'exact' || only?.matchKind === 'approved_history')
  }).length

  const aiReviewedCount = suggestions.filter((item) => {
    const advice = item.aiAdvice
    if (!advice) return false
    return advice.reason !== 'deterministic_exact_match'
      && advice.reason !== 'validated_mapping_cache'
      && advice.reason !== 'local_manual_fallback'
  }).length

  for (const finding of roles) {
    if (ACTIONABLE_ROLES.has(finding.role) && !representedIds.has(finding.sourceRowId)) {
      continue
    }
    for (const code of finding.reasonCodes) {
      rejectedReasonCounts[code] = (rejectedReasonCounts[code] ?? 0) + 1
    }
  }

  // Preserve role findings that were capped out of the 100-row window as rejected.
  if (input.sourceRows.length > sourceRows.length) {
    rejectedReasonCounts.row_cap_excluded =
      (rejectedReasonCounts.row_cap_excluded ?? 0)
      + (input.sourceRows.length - sourceRows.length)
  }

  const reviewWithoutId: Omit<ActionableReview, 'id'> = {
    extractionRunId: input.extractionRunId,
    actionableItemSuggestions: suggestions,
    dismissedEvidence,
    representedRows,
    validationSummary: {
      rawRowCount: sourceRows.length,
      actionableCount: suggestions.length,
      dismissedCount: dismissedEvidence.length,
      representedCount: representedRows.length,
      locallyPreparedCatalogCount,
      aiReviewedCount,
      sourceTotalDifference,
      rejectedReasonCounts,
    },
    versions,
    generatedAt: now,
    mode,
  }

  const fingerprint = buildActionableReviewFingerprint({
    ...reviewWithoutId,
    // fingerprint helper ignores id; temporary empty suggestions ids already set
    actionableItemSuggestions: suggestions,
  })

  const review: ActionableReview = {
    id: fingerprint,
    ...reviewWithoutId,
  }

  const metrics = buildActionableReviewMetrics({
    fingerprint,
    review,
    aiBatch,
  })

  return {
    review,
    metrics,
    aiBatch,
    cacheKeysBySourceRowId,
  }
}
