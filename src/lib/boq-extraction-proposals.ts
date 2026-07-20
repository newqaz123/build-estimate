import { createHash } from 'node:crypto'
import { BOQ_RECONCILIATION_TOLERANCE, type BoqSourceRowV3 } from './boq-extraction-schema'
import { stableCanonicalJson } from './boq-extraction-run'
import type { BoqItem, BoqPricedItem, BoqSection } from './boq-schema'

export const PROPOSAL_OPERATIONS = [
  'keep', 'split', 'merge', 'separate_components', 'create_bundle', 'needs_human_review',
] as const

const PRICING_ROLES = new Set(['standard', 'bundle_parent', 'bundle_child'])
const COST_COMPONENTS = new Set(['material', 'labour', 'combined', 'lump_sum'])

export type ProposalOperation = typeof PROPOSAL_OPERATIONS[number]
export type ProposalCostComponent = 'material' | 'labour' | 'combined' | 'lump_sum'
export type ProposalValidationFailureCode =
  | 'invalid_shape'
  | 'unknown_operation'
  | 'invalid_confidence'
  | 'run_identity_mismatch'
  | 'unknown_source_row'
  | 'missing_source_evidence'
  | 'unknown_target_item'
  | 'duplicate_item_id'
  | 'duplicate_source_row'
  | 'source_provenance_mismatch'
  | 'arithmetic_mismatch'
  | 'reconciliation_mismatch'
  | 'invented_component_price'
  | 'invalid_bundle'
  | 'invalid_operation_shape'
  | 'stale_item'
  | 'target_state_mismatch'
  | 'overlapping_target'
  | 'overlapping_source_row'
  | 'duplicate_proposal'

export interface ProposalSourceComponentEvidence {
  qty: number
  unit: string
  rate: number
  total: number
}

export interface ProposalSourceEvidence {
  quotedTotal: number
  components?: {
    material: ProposalSourceComponentEvidence
    labour: ProposalSourceComponentEvidence
  }
}

export interface ProposalPricedItem {
  id: string
  desc: string
  pricingRole: 'standard' | 'bundle_parent'
  parentBundleId?: null
  sourceRowIds: string[]
  entryOrigin: 'ai_accepted'
  optional?: boolean
  excludedFromTotal?: boolean
  exclusionReason?: string | null
  unit: string
  qty: number
  rate: number
  total: number
  costComponent: ProposalCostComponent
}

export interface ProposalBundleChild {
  id: string
  desc: string
  pricingRole: 'bundle_child'
  parentBundleId: string
  sourceRowIds: string[]
  entryOrigin: 'ai_accepted'
  optional?: boolean
  excludedFromTotal?: boolean
  exclusionReason?: string | null
}

export type ProposedExtractionItem = ProposalPricedItem | ProposalBundleChild

export interface ExtractionProposal {
  id: string
  extractionRunId: string
  operation: ProposalOperation
  sourceRowIds: string[]
  targetItemIds: string[]
  affectedItemFingerprints: Record<string, string>
  confidence: number
  explanation: string
  proposedItems: ProposedExtractionItem[]
}

export interface ProposalValidationContext {
  extractionRunId: string
  sourceRows: ReadonlyArray<Pick<BoqSourceRowV3, 'id'>>
  sourceEvidence: Readonly<Record<string, ProposalSourceEvidence>>
  sections: readonly BoqSection[]
}

export interface ValidatedProposal extends ExtractionProposal {
  evidenceValid: true
  reconciled: true
  stale: boolean
}

export type ProposalValidationResult =
  | { valid: true; proposal: ValidatedProposal }
  | { valid: false; code: ProposalValidationFailureCode }

export interface ProposalBatchValidationResult {
  valid: boolean
  results: ProposalValidationResult[]
}

export interface ProposalAcceptanceAudit {
  proposalId: string
  operation: ProposalOperation
  beforeSections: BoqSection[]
  beforeSectionsFingerprint: string
  afterSectionsFingerprint: string
}

export class ProposalUndoConflictError extends Error {
  constructor() {
    super('Cannot undo this proposal because the BOQ changed after acceptance')
    this.name = 'ProposalUndoConflictError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= BOQ_RECONCILIATION_TOLERANCE
}

function hasUniqueStrings(values: unknown): values is string[] {
  return Array.isArray(values) && values.every(nonBlankString) && new Set(values).size === values.length
}

function validOptionalState(item: Record<string, unknown>): boolean {
  if (item.optional !== undefined && typeof item.optional !== 'boolean') return false
  if (item.excludedFromTotal !== undefined && typeof item.excludedFromTotal !== 'boolean') return false
  if (item.exclusionReason !== undefined && item.exclusionReason !== null && typeof item.exclusionReason !== 'string') return false
  const excluded = item.excludedFromTotal === true
  const optional = item.optional === true
  const reason = item.exclusionReason
  if (excluded && (!optional || typeof reason !== 'string' || reason.trim() === '')) return false
  if (!excluded && reason !== undefined && reason !== null) return false
  return true
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableCanonicalJson(value)).digest('hex')}`
}

export function fingerprintCanonicalItem(item: BoqItem): string {
  return digest(item)
}

function fingerprintSections(sections: readonly BoqSection[]): string {
  return digest(sections)
}

function fail(code: ProposalValidationFailureCode): ProposalValidationResult {
  return { valid: false, code }
}

function knownItems(sections: readonly BoqSection[]): Map<string, BoqItem> {
  const items = new Map<string, BoqItem>()
  for (const section of sections) {
    for (const item of section.items) if (nonBlankString(item.id)) items.set(item.id, item)
  }
  return items
}

function quotedTotal(sourceRowIds: readonly string[], context: ProposalValidationContext): number | null {
  let sum = 0
  for (const sourceRowId of sourceRowIds) {
    const evidence = context.sourceEvidence[sourceRowId]
    if (!evidence || !Object.prototype.hasOwnProperty.call(evidence, 'quotedTotal') || !finiteNonNegative(evidence.quotedTotal)) return null
    sum += evidence.quotedTotal
  }
  return Number.isFinite(sum) ? sum : null
}

function hasValidComponent(component: unknown): component is ProposalSourceComponentEvidence {
  return isRecord(component)
    && finiteNonNegative(component.qty)
    && nonBlankString(component.unit)
    && finiteNonNegative(component.rate)
    && finiteNonNegative(component.total)
    && approximatelyEqual(component.qty * component.rate, component.total)
}

function validProposedItem(
  item: unknown,
  proposalSourceRowIds: readonly string[],
): item is ProposedExtractionItem {
  if (!isRecord(item)
    || !nonBlankString(item.id)
    || !nonBlankString(item.desc)
    || !PRICING_ROLES.has(item.pricingRole as string)
    || !hasUniqueStrings(item.sourceRowIds)
    || item.sourceRowIds.length === 0
    || item.sourceRowIds.some((sourceRowId) => !proposalSourceRowIds.includes(sourceRowId))
    || item.entryOrigin !== 'ai_accepted'
    || !validOptionalState(item)
  ) return false

  if (item.pricingRole === 'bundle_child') {
    if (item.optional === true || item.excludedFromTotal === true || item.exclusionReason !== undefined && item.exclusionReason !== null) return false
    return nonBlankString(item.parentBundleId)
      && !('unit' in item) && !('qty' in item) && !('rate' in item) && !('total' in item) && !('costComponent' in item)
  }
  return (item.pricingRole === 'standard' || item.pricingRole === 'bundle_parent')
    && (item.parentBundleId === undefined || item.parentBundleId === null)
    && nonBlankString(item.unit)
    && finiteNonNegative(item.qty)
    && finiteNonNegative(item.rate)
    && finiteNonNegative(item.total)
    && COST_COMPONENTS.has(item.costComponent as string)
    && approximatelyEqual(item.qty * item.rate, item.total)
}

function everyPriced(items: readonly ProposedExtractionItem[]): items is ProposalPricedItem[] {
  return items.every((item) => item.pricingRole !== 'bundle_child')
}

function totals(items: readonly ProposalPricedItem[]): number {
  return items.reduce((sum, item) => sum + item.total, 0)
}

function validateOperation(proposal: ExtractionProposal, context: ProposalValidationContext): ProposalValidationResult {
  const expectedTotal = quotedTotal(proposal.sourceRowIds, context)
  const proposed = proposal.proposedItems
  if ((proposal.operation === 'keep' || proposal.operation === 'needs_human_review') && proposed.length !== 0) {
    return fail('invalid_operation_shape')
  }
  if (proposal.operation === 'keep' || proposal.operation === 'needs_human_review') {
    if (proposal.targetItemIds.length === 0 || proposal.sourceRowIds.length === 0) return fail('invalid_operation_shape')
    if (expectedTotal === null) return fail('missing_source_evidence')
    return validProposal(proposal)
  }
  if (expectedTotal === null) return fail('missing_source_evidence')

  if (proposal.operation === 'split') {
    if (proposal.targetItemIds.length !== 1 || proposed.length < 2 || !everyPriced(proposed)
      || proposed.some((item) => item.pricingRole !== 'standard')
      || !approximatelyEqual(totals(proposed), expectedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  if (proposal.operation === 'merge') {
    if (proposal.targetItemIds.length < 2 || proposed.length !== 1 || !everyPriced(proposed)
      || proposed[0].pricingRole !== 'standard') {
      return fail('invalid_operation_shape')
    }
    if (!approximatelyEqual(proposed[0].total, expectedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  if (proposal.operation === 'separate_components') {
    if (proposal.targetItemIds.length !== 1 || proposal.sourceRowIds.length !== 1 || proposed.length !== 2 || !everyPriced(proposed)) {
      return fail('invalid_operation_shape')
    }
    const evidence = context.sourceEvidence[proposal.sourceRowIds[0]]
    if (!evidence?.components) return fail('invented_component_price')
    const material = proposed.find((item) => item.costComponent === 'material')
    const labour = proposed.find((item) => item.costComponent === 'labour')
    if (!material || !labour || proposed.some((item) => item.pricingRole !== 'standard')
      || proposed.some((item) => item.costComponent !== 'material' && item.costComponent !== 'labour')) {
      return fail('invalid_operation_shape')
    }
    if (!hasValidComponent(evidence.components.material) || !hasValidComponent(evidence.components.labour)) return fail('missing_source_evidence')
    if (!sameComponent(material, evidence.components.material) || !sameComponent(labour, evidence.components.labour)) {
      return fail('invented_component_price')
    }
    if (!approximatelyEqual(material.total + labour.total, evidence.quotedTotal)) return fail('reconciliation_mismatch')
    return validProposal(proposal)
  }

  if (proposal.operation === 'create_bundle') {
    const parents = proposed.filter((item): item is ProposalPricedItem => item.pricingRole === 'bundle_parent')
    const children = proposed.filter((item): item is ProposalBundleChild => item.pricingRole === 'bundle_child')
    if (parents.length !== 1 || children.length === 0 || proposed.length !== parents.length + children.length
      || children.some((child) => child.parentBundleId !== parents[0].id)
      || !approximatelyEqual(parents[0].total, expectedTotal)) return fail('invalid_bundle')
    return validProposal(proposal)
  }

  return fail('unknown_operation')
}

function optionalState(value: {
  optional?: boolean
  excludedFromTotal?: boolean
  exclusionReason?: string | null
}): {
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason: string | null
} {
  return {
    optional: value.optional === true,
    excludedFromTotal: value.excludedFromTotal === true,
    exclusionReason: value.exclusionReason ?? null,
  }
}

function sameOptionalState(
  left: ReturnType<typeof optionalState>,
  right: ReturnType<typeof optionalState>,
): boolean {
  return left.optional === right.optional
    && left.excludedFromTotal === right.excludedFromTotal
    && left.exclusionReason === right.exclusionReason
}

function validateTargetOptionalState(
  proposal: ExtractionProposal,
  context: ProposalValidationContext,
): ProposalValidationResult | null {
  if (proposal.proposedItems.length === 0) return null
  const known = knownItems(context.sections)
  const targets = proposal.targetItemIds.map((id) => known.get(id)).filter((item): item is BoqItem => item !== undefined)
  if (targets.length !== proposal.targetItemIds.length) return fail('unknown_target_item')
  const states = targets.map(optionalState)
  const expected = states[0]
  if (!expected || states.some((state) => !sameOptionalState(state, expected))) return fail('target_state_mismatch')
  const priced = proposal.proposedItems.filter((item) => item.pricingRole !== 'bundle_child')
  if (priced.some((item) => !sameOptionalState(optionalState(item), expected))) return fail('target_state_mismatch')
  return null
}

function sameComponent(item: ProposalPricedItem, evidence: ProposalSourceComponentEvidence): boolean {
  return item.unit === evidence.unit
    && approximatelyEqual(item.qty, evidence.qty)
    && approximatelyEqual(item.rate, evidence.rate)
    && approximatelyEqual(item.total, evidence.total)
}

function validProposal(proposal: ExtractionProposal): ProposalValidationResult {
  return {
    valid: true,
    proposal: { ...structuredClone(proposal), evidenceValid: true, reconciled: true, stale: false },
  }
}

/**
 * Validates untrusted structured model output. Validation never changes canonical
 * BOQ sections; only a separately authorized acceptance path may call apply.
 */
export function validateProposal(value: unknown, context: ProposalValidationContext): ProposalValidationResult {
  if (!isRecord(value)
    || !nonBlankString(value.id)
    || !nonBlankString(value.operation)
    || !Array.isArray(value.sourceRowIds)
    || !value.sourceRowIds.every(nonBlankString)
    || !Array.isArray(value.targetItemIds)
    || !value.targetItemIds.every(nonBlankString)
    || !isRecord(value.affectedItemFingerprints)
    || !nonBlankString(value.explanation)
    || !Array.isArray(value.proposedItems)
  ) return fail('invalid_shape')

  if (!PROPOSAL_OPERATIONS.includes(value.operation as ProposalOperation)) return fail('unknown_operation')
  if (!finiteNonNegative(value.confidence) || value.confidence > 1) return fail('invalid_confidence')
  if (!nonBlankString(value.extractionRunId)) return fail('run_identity_mismatch')

  const proposal = value as unknown as ExtractionProposal
  if (proposal.extractionRunId !== context.extractionRunId) return fail('run_identity_mismatch')
  if (proposal.sourceRowIds.length === 0) return fail('invalid_operation_shape')
  if (new Set(proposal.sourceRowIds).size !== proposal.sourceRowIds.length) return fail('duplicate_source_row')
  if (new Set(proposal.targetItemIds).size !== proposal.targetItemIds.length) return fail('invalid_operation_shape')
  const knownSourceRows = new Set(context.sourceRows.map((row) => row.id))
  if (proposal.sourceRowIds.some((sourceRowId) => !knownSourceRows.has(sourceRowId))) return fail('unknown_source_row')
  const known = knownItems(context.sections)
  if (proposal.targetItemIds.some((itemId) => !known.has(itemId))) return fail('unknown_target_item')
  if (proposal.targetItemIds.length === 0) return fail('invalid_operation_shape')
  if (Object.keys(proposal.affectedItemFingerprints).length !== proposal.targetItemIds.length
    || proposal.targetItemIds.some((itemId) => typeof proposal.affectedItemFingerprints[itemId] !== 'string'
      || proposal.affectedItemFingerprints[itemId] !== fingerprintCanonicalItem(known.get(itemId)!))) {
    return fail('stale_item')
  }

  if (!proposal.proposedItems.every((item) => validProposedItem(item, proposal.sourceRowIds))) {
    const arithmetic = proposal.proposedItems.some((item) => isRecord(item)
      && item.pricingRole !== 'bundle_child'
      && finiteNonNegative(item.qty) && finiteNonNegative(item.rate) && finiteNonNegative(item.total)
      && !approximatelyEqual(item.qty * item.rate, item.total))
    return fail(arithmetic ? 'arithmetic_mismatch' : 'invalid_shape')
  }
  if (proposal.proposedItems.length > 0) {
    const proposedSourceRows = new Set(proposal.proposedItems.flatMap((item) => item.sourceRowIds))
    if (proposedSourceRows.size !== proposal.sourceRowIds.length
      || proposal.sourceRowIds.some((sourceRowId) => !proposedSourceRows.has(sourceRowId))) {
      return fail('source_provenance_mismatch')
    }
  }
  const proposedIds = proposal.proposedItems.map((item) => item.id)
  if (new Set(proposedIds).size !== proposedIds.length) return fail('duplicate_item_id')
  if (proposedIds.some((itemId) => known.has(itemId) && !proposal.targetItemIds.includes(itemId))) return fail('duplicate_item_id')
  const targetStateFailure = validateTargetOptionalState(proposal, context)
  if (targetStateFailure) return targetStateFailure
  return validateOperation(proposal, context)
}

export function validateProposalBatch(values: unknown[], context: ProposalValidationContext): ProposalBatchValidationResult {
  const seenProposalIds = new Set<string>()
  const seenTargets = new Set<string>()
  const seenRows = new Set<string>()
  const results = values.map((value) => {
    const result = validateProposal(value, context)
    if (!result.valid) return result
    if (seenProposalIds.has(result.proposal.id)) return fail('duplicate_proposal')
    if (result.proposal.targetItemIds.some((id) => seenTargets.has(id))) return fail('overlapping_target')
    if (result.proposal.sourceRowIds.some((id) => seenRows.has(id))) return fail('overlapping_source_row')
    seenProposalIds.add(result.proposal.id)
    result.proposal.targetItemIds.forEach((id) => seenTargets.add(id))
    result.proposal.sourceRowIds.forEach((id) => seenRows.add(id))
    return result
  })
  return { valid: results.every((result) => result.valid), results }
}

export function isHighConfidenceProposal(proposal: ValidatedProposal): boolean {
  return proposal.confidence >= 0.90
    && proposal.evidenceValid
    && proposal.reconciled
    && proposal.operation !== 'needs_human_review'
    && proposal.stale !== true
}

function toCanonicalItem(item: ProposedExtractionItem): BoqItem {
  const common = {
    id: item.id,
    desc: item.desc,
    sourceRowId: item.sourceRowIds[0],
    sourceRowIds: [...item.sourceRowIds],
    entryOrigin: 'ai_accepted' as const,
    ...(item.optional === true ? { optional: true } : {}),
    ...(item.excludedFromTotal === true ? { excludedFromTotal: true } : {}),
    ...(nonBlankString(item.exclusionReason) ? { exclusionReason: item.exclusionReason } : {}),
  }
  if (item.pricingRole === 'bundle_child') {
    return { ...common, pricingRole: 'bundle_child', parentBundleId: item.parentBundleId, stdStatus: 'pending' }
  }
  const priced: BoqPricedItem = {
    ...common,
    pricingRole: item.pricingRole,
    unit: item.unit,
    qty: item.qty,
    rate: item.rate,
    total: item.total,
    type: item.costComponent === 'lump_sum' ? 'lump_sum' : 'unit',
    costComponent: item.costComponent,
    stdStatus: item.excludedFromTotal === true ? 'excluded' : 'unmatched',
  }
  return priced
}

/** Applies only a previously validated proposal after explicit user acceptance. */
export function applyValidatedProposal(
  sections: readonly BoqSection[],
  proposal: ValidatedProposal,
): { sections: BoqSection[]; audit: ProposalAcceptanceAudit } {
  if (proposal.operation === 'needs_human_review') throw new TypeError('A human review proposal cannot be applied')
  const beforeSections = structuredClone(sections) as BoqSection[]
  const current = knownItems(beforeSections)
  if (proposal.targetItemIds.some((id) => {
    const currentItem = current.get(id)
    return !currentItem || fingerprintCanonicalItem(currentItem) !== proposal.affectedItemFingerprints[id]
  })) {
    throw new ProposalUndoConflictError()
  }
  const affectedSections = beforeSections
    .map((section, sectionIndex) => ({ sectionIndex, hasTarget: section.items.some((item) => proposal.targetItemIds.includes(item.id ?? '')) }))
    .filter((entry) => entry.hasTarget)
  if (affectedSections.length !== 1) throw new TypeError('A proposal must replace targets from exactly one section')
  const sectionIndex = affectedSections[0].sectionIndex
  const targetIds = new Set(proposal.targetItemIds)
  const targetIndexes = beforeSections[sectionIndex].items
    .map((item, index) => targetIds.has(item.id ?? '') ? index : -1)
    .filter((index) => index >= 0)
  const insertAt = Math.min(...targetIndexes)
  const nextItems = proposal.operation === 'keep'
    ? [...beforeSections[sectionIndex].items]
    : beforeSections[sectionIndex].items.filter((item) => !targetIds.has(item.id ?? ''))
  if (proposal.operation !== 'keep') nextItems.splice(insertAt, 0, ...proposal.proposedItems.map(toCanonicalItem))
  const nextSections = beforeSections.map((section, index) => index === sectionIndex ? { ...section, items: nextItems } : section)
  const audit: ProposalAcceptanceAudit = {
    proposalId: proposal.id,
    operation: proposal.operation,
    beforeSections,
    beforeSectionsFingerprint: fingerprintSections(beforeSections),
    afterSectionsFingerprint: fingerprintSections(nextSections),
  }
  return { sections: nextSections, audit }
}

export function undoAcceptedProposal(sections: readonly BoqSection[], audit: ProposalAcceptanceAudit): BoqSection[] {
  if (fingerprintSections(sections) !== audit.afterSectionsFingerprint) throw new ProposalUndoConflictError()
  return structuredClone(audit.beforeSections)
}
