import {
  fingerprintCanonicalItem,
  PROPOSAL_OPERATIONS,
  type ExtractionProposal,
  type ProposalOperation,
} from './boq-extraction-proposals'
import type { BoqItem } from './boq-schema'

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
