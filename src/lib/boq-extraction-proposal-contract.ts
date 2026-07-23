import {
  fingerprintCanonicalItem,
  fingerprintCanonicalSections,
  PROPOSAL_OPERATIONS,
  type ExtractionProposal,
  type ProposalOperation,
  type ProposalPricedItem,
  type ProposedExtractionItem,
  type ProposalSourceComponentEvidence,
} from './boq-extraction-proposals'
import type { BoqItem, BoqSection, BoqSourceRef } from './boq-schema'

/**
 * Provider-facing DTO — the exact JSON shape the LLM must return.
 * Server-owned metadata (extractionRunId, affectedItemFingerprints, entryOrigin)
 * is intentionally absent: the model cannot compute cryptographic fingerprints,
 * should not echo run identity, and must never set provenance. Those fields are
 * injected by {@link prepareProviderProposal} before strict validation.
 */

const PROPOSAL_KEYS = new Set([
  'id', 'operation', 'sourceRowIds', 'targetItemIds', 'confidence', 'explanation', 'proposedItems',
])

const PRICED_ITEM_REQUIRED_KEYS = [
  'id', 'desc', 'pricingRole', 'parentBundleId', 'sourceRowIds',
  'optional', 'excludedFromTotal', 'exclusionReason',
  'unit', 'qty', 'rate', 'total', 'costComponent',
] as const
const PRICED_ITEM_KEYS = new Set<string>(PRICED_ITEM_REQUIRED_KEYS)

const CHILD_ITEM_KEYS = new Set(['id', 'desc', 'pricingRole', 'parentBundleId', 'sourceRowIds'])

const PRICING_ROLES = new Set(['standard', 'bundle_parent', 'bundle_child'])
const COST_COMPONENTS = new Set(['material', 'labour', 'combined', 'lump_sum'])
const OPERATION_LIST = [...PROPOSAL_OPERATIONS]

export interface ProviderProposalContext {
  extractionRunId: string
  targetItems: ReadonlyMap<string, BoqItem>
}

export type ProviderProposalPreparation =
  | { ok: true; proposal: ExtractionProposal }
  | { ok: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).some((key) => !allowed.has(key))
}

function preparePricedItem(item: Record<string, unknown>): Record<string, unknown> | null {
  if (hasUnknownKeys(item, PRICED_ITEM_KEYS)) return null
  if (!PRICED_ITEM_REQUIRED_KEYS.every((key) => key in item)) return null
  if (!nonBlankString(item.id) || !nonBlankString(item.desc)) return null
  if (item.pricingRole !== 'standard' && item.pricingRole !== 'bundle_parent') return null
  if (item.parentBundleId !== null) return null
  if (!isStringArray(item.sourceRowIds)) return null
  if (typeof item.optional !== 'boolean') return null
  if (typeof item.excludedFromTotal !== 'boolean') return null
  if (item.exclusionReason !== null && typeof item.exclusionReason !== 'string') return null
  if (!nonBlankString(item.unit)) return null
  if (!finiteNumber(item.qty) || item.qty < 0) return null
  if (!finiteNumber(item.rate) || item.rate < 0) return null
  if (!finiteNumber(item.total) || item.total < 0) return null
  if (!COST_COMPONENTS.has(item.costComponent as string)) return null
  return { ...item, entryOrigin: 'ai_accepted' as const }
}

function prepareChildItem(item: Record<string, unknown>): Record<string, unknown> | null {
  if (hasUnknownKeys(item, CHILD_ITEM_KEYS)) return null
  if (!nonBlankString(item.id) || !nonBlankString(item.desc)) return null
  if (item.pricingRole !== 'bundle_child') return null
  if (!nonBlankString(item.parentBundleId)) return null
  if (!isStringArray(item.sourceRowIds)) return null
  return { ...item, entryOrigin: 'ai_accepted' as const }
}

function prepareProposedItem(item: unknown): Record<string, unknown> | null {
  if (!isRecord(item)) return null
  if (!PRICING_ROLES.has(item.pricingRole as string)) return null
  if (item.pricingRole === 'bundle_child') return prepareChildItem(item)
  return preparePricedItem(item)
}

/**
 * Validates the provider DTO shape and injects server-owned metadata.
 *
 * Structural failures (missing fields, wrong types, unknown keys) return
 * `{ ok: false }` which maps to `invalid_shape` in the caller. Semantic
 * failures (confidence range, arithmetic, evidence, target existence) are left
 * to the existing strict validator.
 *
 * Normalization boundary: this function never coerces values. Numeric strings
 * stay strings (and fail), singular IDs stay singular (and fail), operation
 * casing is not adjusted, prices are never inferred, and evidence is never
 * fabricated. Unknown or malformed content remains rejected.
 */
export function prepareProviderProposal(
  value: unknown,
  context: ProviderProposalContext,
): ProviderProposalPreparation {
  if (!isRecord(value) || hasUnknownKeys(value, PROPOSAL_KEYS)) return { ok: false }
  if (!nonBlankString(value.id)) return { ok: false }
  if (!OPERATION_LIST.includes(value.operation as ProposalOperation)) return { ok: false }
  if (!isStringArray(value.sourceRowIds)) return { ok: false }
  if (!isStringArray(value.targetItemIds)) return { ok: false }
  if (!finiteNumber(value.confidence)) return { ok: false }
  if (!nonBlankString(value.explanation)) return { ok: false }
  if (!Array.isArray(value.proposedItems)) return { ok: false }

  const preparedItems: Record<string, unknown>[] = []
  for (const rawItem of value.proposedItems) {
    const prepared = prepareProposedItem(rawItem)
    if (!prepared) return { ok: false }
    preparedItems.push(prepared)
  }

  const targetItemIds = value.targetItemIds as string[]
  const affectedItemFingerprints: Record<string, string> = {}
  for (const targetId of targetItemIds) {
    const targetItem = context.targetItems.get(targetId)
    if (targetItem) affectedItemFingerprints[targetId] = fingerprintCanonicalItem(targetItem)
  }

  const proposal: ExtractionProposal = {
    id: value.id as string,
    extractionRunId: context.extractionRunId,
    operation: value.operation as ProposalOperation,
    sourceRowIds: value.sourceRowIds as string[],
    targetItemIds,
    affectedItemFingerprints,
    confidence: value.confidence as number,
    explanation: value.explanation as string,
    proposedItems: preparedItems as unknown as ExtractionProposal['proposedItems'],
  }
  return { ok: true, proposal }
}

/**
 * Deterministic instructions serialised into the system message so the model
 * knows the exact JSON shape to return. Kept concise to respect prompt limits.
 */
export function providerContractInstructions(): string {
  const operations = OPERATION_LIST.map((op) => `"${op}"`).join(' | ')
  const components = [...COST_COMPONENTS].map((c) => `"${c}"`).join(' | ')
  return [
    'RESPONSE CONTRACT — return JSON only. No markdown, no prose, no code fences.',
    '',
    `Envelope: {"proposals":[<proposal>]}  (no other top-level keys)`,
    '',
    'Each proposal has EXACTLY these keys (no extras):',
    '  id: string',
    `  operation: ${operations}`,
    '  sourceRowIds: string[]   (use only IDs from allowedSourceRowIds)',
    '  targetItemIds: string[]  (use only IDs from currentTargetItems[].id)',
    '  confidence: number       (0.0–1.0)',
    '  explanation: string',
    '  proposedItems: <item>[]',
    '',
    'Priced item (pricingRole "standard" or "bundle_parent") — EXACTLY these keys:',
    '  id, desc, pricingRole, parentBundleId: null, sourceRowIds: string[],',
    '  unit: string, qty: number, rate: number, total: number,',
    `  costComponent: ${components},`,
    '  optional: boolean (copy from target), excludedFromTotal: boolean (copy from target),',
    '  exclusionReason: string|null (copy from target)',
    '',
    'Bundle child item (pricingRole "bundle_child") — EXACTLY these keys:',
    '  id, desc, pricingRole, parentBundleId: string (the parent item id), sourceRowIds: string[]',
    '',
    'FORBIDDEN — never include these keys: extractionRunId, affectedItemFingerprints, entryOrigin, fingerprints.',
    'FORBIDDEN — never invent prices, rates, quantities, unit, or material/labour costs.',
    'FORBIDDEN — never copy example or synthetic IDs; use real IDs from the provided data only.',
    '',
    'OPERATION RULES:',
    '  keep / needs_human_review: proposedItems must be []. Requires ≥1 targetId and ≥1 sourceRowId.',
    '  split: exactly 1 targetId, ≥2 standard priced items. Sum of item totals must equal sourceEvidence quotedTotal.',
    '  merge: ≥2 targetIds, exactly 1 standard priced item. Item total must equal quotedTotal.',
    '  separate_components: exactly 1 targetId and 1 sourceRowId, exactly 2 items (one costComponent "material", one "labour"). Copy qty/unit/rate/total from sourceEvidence.components.',
    '  create_bundle: 1 bundle_parent (priced) + ≥1 bundle_child (unpriced). Parent total must equal quotedTotal.',
    '',
    'If no safe correction can be constructed, return: {"proposals":[]}',
    'Example keep proposal (shape only — do NOT copy these IDs):',
    '  {"proposals":[{"id":"p1","operation":"keep","sourceRowIds":["sr-1"],"targetItemIds":["t1"],"confidence":0.95,"explanation":"OK","proposedItems":[]}]}',
  ].join('\n')
}

// ─── v2 Provider Decision DTO ─────────────────────────────────────────────
// The v2 contract is built around candidate references, not model-authored
// values. The provider may only reference candidateItemIds from the prompt
// packet; the server expands those references into full proposedItems.

const V2_PROPOSAL_KEYS = new Set([
  'id', 'operation', 'sourceRowIds', 'targetItemIds', 'candidateItemIds', 'confidence', 'explanation',
])

const V2_OPERATIONS: readonly ProposalOperation[] = [
  'insert_missing_item', 'replace_item', 'remove_spurious_item', 'needs_human_review',
]

export interface ProviderCandidateRef {
  id: string
  sectionIndex: number
  sectionHeader: string
  sourceOrder: number
  sourceRowIds: string[]
  sourceRefs?: BoqSourceRef[]
  desc: string
  pricingRole: 'standard'
  parentBundleId: null
  unit: string
  qty: number
  rate: number
  total: number
  costComponent: string
  sourceCosts?: { material: ProposalSourceComponentEvidence; labour: ProposalSourceComponentEvidence } | null
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason: string | null
}

export interface ProviderProposalContextV2 {
  extractionRunId: string
  sections: readonly BoqSection[]
  targetItems: ReadonlyMap<string, BoqItem>
  candidateItems: ReadonlyMap<string, ProviderCandidateRef>
}

export type ProviderProposalPreparationV2 =
  | { ok: true; proposal: ExtractionProposal }
  | { ok: false }

function itemSourceRows(item: BoqItem): string[] {
  if (Array.isArray(item.sourceRowIds) && item.sourceRowIds.length > 0) return item.sourceRowIds
  return item.sourceRowId ? [item.sourceRowId] : []
}

function destinationSectionIndex(candidates: readonly ProviderCandidateRef[], sections: readonly BoqSection[]): number | null {
  const indexes = new Set(candidates.map((candidate) => candidate.sectionIndex))
  const headers = new Set(candidates.map((candidate) => candidate.sectionHeader))
  if (indexes.size !== 1 || headers.size !== 1) return null
  const runIndex = candidates[0].sectionIndex
  const header = candidates[0].sectionHeader
  if (sections[runIndex]?.header === header) return runIndex
  const matches = sections.flatMap((section, index) => section.header === header ? [index] : [])
  return matches.length === 1 ? matches[0] : null
}

function itemSourceOrder(item: BoqItem, candidates: ReadonlyMap<string, ProviderCandidateRef>): number {
  const sources = new Set(itemSourceRows(item))
  let order = Number.MAX_SAFE_INTEGER
  for (const candidate of candidates.values()) {
    if (candidate.sourceRowIds.some((id) => sources.has(id))) order = Math.min(order, candidate.sourceOrder)
  }
  return order
}

/** Validate the v2 provider decision DTO and expand candidate references
 *  into full proposedItems using immutable server-owned candidate data.
 *
 *  The model never authors description, unit, qty, rate, total, or component
 *  prices — those come exclusively from the server-owned candidates. */
export function prepareProviderProposalV2(
  value: unknown,
  context: ProviderProposalContextV2,
): ProviderProposalPreparationV2 {
  if (!isRecord(value) || hasUnknownKeys(value, V2_PROPOSAL_KEYS)) return { ok: false }
  if (!nonBlankString(value.id) || !V2_OPERATIONS.includes(value.operation as ProposalOperation)) return { ok: false }
  if (!isStringArray(value.sourceRowIds) || !isStringArray(value.targetItemIds)
    || !isStringArray(value.candidateItemIds) || !finiteNumber(value.confidence)
    || value.confidence < 0 || value.confidence > 1 || !nonBlankString(value.explanation)) return { ok: false }

  const operation = value.operation as ProposalOperation
  const sourceRowIds = value.sourceRowIds as string[]
  const targetItemIds = value.targetItemIds as string[]
  const candidateItemIds = value.candidateItemIds as string[]
  if (sourceRowIds.length === 0
    || new Set(sourceRowIds).size !== sourceRowIds.length
    || new Set(targetItemIds).size !== targetItemIds.length
    || new Set(candidateItemIds).size !== candidateItemIds.length) return { ok: false }
  if (operation === 'insert_missing_item' && (targetItemIds.length !== 0 || candidateItemIds.length === 0)) return { ok: false }
  if (operation === 'replace_item' && (targetItemIds.length === 0 || candidateItemIds.length === 0)) return { ok: false }
  if (operation === 'remove_spurious_item' && (targetItemIds.length === 0 || candidateItemIds.length !== 0)) return { ok: false }
  if (operation === 'needs_human_review' && candidateItemIds.length !== 0) return { ok: false }
  if (targetItemIds.some((id) => !context.targetItems.has(id))) return { ok: false }

  const candidates = candidateItemIds.map((id) => context.candidateItems.get(id))
  if (candidates.some((candidate) => !candidate)) return { ok: false }
  const knownCandidates = (candidates as ProviderCandidateRef[])
    .sort((left, right) => left.sourceOrder - right.sourceOrder || left.id.localeCompare(right.id))
  if (knownCandidates.some((candidate) => String(candidate.pricingRole) !== 'standard')) return { ok: false }
  if (knownCandidates.length > 0) {
    const candidateSources = new Set(knownCandidates.flatMap((candidate) => candidate.sourceRowIds))
    if (candidateSources.size !== sourceRowIds.length || sourceRowIds.some((id) => !candidateSources.has(id))) return { ok: false }
  }

  const proposedItems: ProposedExtractionItem[] = knownCandidates.map((candidate) => ({
    id: candidate.id,
    desc: candidate.desc,
    pricingRole: candidate.pricingRole,
    parentBundleId: candidate.parentBundleId,
    sourceRowIds: [...candidate.sourceRowIds],
    ...(candidate.sourceRefs?.[0] ? { sourceRef: { ...candidate.sourceRefs[0] } } : {}),
    entryOrigin: 'ai_accepted',
    optional: candidate.optional,
    excludedFromTotal: candidate.excludedFromTotal,
    exclusionReason: candidate.exclusionReason,
    unit: candidate.unit,
    qty: candidate.qty,
    rate: candidate.rate,
    total: candidate.total,
    costComponent: candidate.costComponent as ProposalPricedItem['costComponent'],
    ...(candidate.sourceCosts ? { sourceCosts: structuredClone(candidate.sourceCosts) } : {}),
  } as ProposedExtractionItem))

  const affectedItemFingerprints: Record<string, string> = {}
  for (const targetId of targetItemIds) affectedItemFingerprints[targetId] = fingerprintCanonicalItem(context.targetItems.get(targetId)!)

  let resolvedSectionIndex: number | undefined
  let resolvedItemIndex: number | undefined
  let candidateSourceOrder: number | undefined
  if (knownCandidates.length > 0) {
    const sectionIndex = destinationSectionIndex(knownCandidates, context.sections)
    if (sectionIndex === null) return { ok: false }
    resolvedSectionIndex = sectionIndex
    candidateSourceOrder = Math.min(...knownCandidates.map((candidate) => candidate.sourceOrder))
    if (operation === 'replace_item') {
      const targetSet = new Set(targetItemIds)
      const indexes = context.sections[sectionIndex].items.flatMap((item, index) => targetSet.has(item.id ?? '') ? [index] : [])
      if (indexes.length !== targetItemIds.length) return { ok: false }
      resolvedItemIndex = Math.min(...indexes)
    } else {
      const firstAfter = context.sections[sectionIndex].items.findIndex((item) =>
        itemSourceOrder(item, context.candidateItems) > candidateSourceOrder!)
      resolvedItemIndex = firstAfter === -1 ? context.sections[sectionIndex].items.length : firstAfter
    }
  }

  const proposal: ExtractionProposal = {
    id: value.id as string,
    extractionRunId: context.extractionRunId,
    operation,
    candidateItemIds: [...candidateItemIds],
    baseSectionsFingerprint: fingerprintCanonicalSections(context.sections),
    ...(resolvedSectionIndex === undefined ? {} : { destinationSectionIndex: resolvedSectionIndex }),
    ...(resolvedItemIndex === undefined ? {} : { destinationItemIndex: resolvedItemIndex }),
    ...(candidateSourceOrder === undefined ? {} : { candidateSourceOrder }),
    sourceRowIds,
    targetItemIds,
    affectedItemFingerprints,
    confidence: value.confidence as number,
    explanation: value.explanation as string,
    proposedItems,
  }
  return { ok: true, proposal }
}

/** v2 system instructions — the model decides which candidates to
 *  insert/replace/remove, never authors values. */
export function providerContractInstructionsV2(): string {
  return [
    'RESPONSE CONTRACT — return JSON only. No markdown, no prose, no code fences.',
    '',
    'Envelope: {"proposals":[<decision>]}  (no other top-level keys)',
    '',
    'Each decision has EXACTLY these keys:',
    '  id: string',
    '  operation: "insert_missing_item" | "replace_item" | "remove_spurious_item" | "needs_human_review"',
    '  sourceRowIds: string[]   (use only IDs from allowedSourceRowIds)',
    '  targetItemIds: string[]  (use only IDs from currentTargetItems[].id; empty for insert_missing_item)',
    '  candidateItemIds: string[]  (use only IDs from candidateItems[].id; empty for remove_spurious_item and needs_human_review)',
    '  confidence: number       (0.0–1.0)',
    '  explanation: string      (why this correction is needed)',
    '',
    'DECISION RULES:',
    '  insert_missing_item: A priced source row exists in candidateItems but has no matching item in currentTargetItems.',
    '    Set targetItemIds to [], candidateItemIds to the candidate(s) to add.',
    '  replace_item: A currentTargetItem was derived incorrectly and should be replaced by the correct candidate(s).',
    '    Set targetItemIds to the wrong item(s), candidateItemIds to the replacement(s).',
    '  remove_spurious_item: A currentTargetItem is backed only by a structural header/section/total/note or numeric-only summary row, never an ordinary item row.',
    '    Set targetItemIds to the spurious item(s), candidateItemIds to [].',
    '  needs_human_review: A source row needs manual attention and no safe automatic correction exists.',
    '    Set candidateItemIds to []. Bundle rows without an actionable candidate must use this decision.',
    '',
    'NEVER invent prices, rates, quantities, descriptions, or units. All values come from the provided candidateItems.',
    'NEVER include proposedItems, extractionRunId, fingerprints, or entryOrigin.',
    'NEVER propose keep or separate_components — those are not valid v2 operations.',
    'NEVER propose splitting a combined material/labour row into separate items — keep combined rows as one line.',
    '',
    'If the extraction looks correct (all candidates have matching targets, no spurious items), return: {"proposals":[]}',
    '',
    'Example insert (shape only — do NOT copy these IDs):',
    '  {"proposals":[{"id":"d1","operation":"insert_missing_item","sourceRowIds":["sr-1"],"targetItemIds":[],"candidateItemIds":["cand-1"],"confidence":0.95,"explanation":"Source row was omitted from the BOQ."}]}',
  ].join('\n')
}
