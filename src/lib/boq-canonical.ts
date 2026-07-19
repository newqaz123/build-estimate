import type { BoqItem, BoqSection } from './boq-schema'

const STD_STATUSES = new Set(['matched', 'unmatched', 'pending', 'excluded'])
const PRICING_ROLES = new Set(['standard', 'bundle_parent', 'bundle_child'])
const ITEM_TYPES = new Set(['unit', 'lump_sum', 'job'])
const ENTRY_ORIGINS = new Set(['docling', 'ai_accepted', 'user'])
const STD_CONFIDENCES = new Set(['exact', 'fuzzy', 'llm', 'manual'])
const COST_COMPONENTS = new Set(['material', 'labour', 'combined', 'lump_sum'])
const COST_ALLOCATION_BASES = new Set(['rate', 'total'])
const COST_ALLOCATION_ORIGINS = new Set(['source', 'manual'])

export class BoqCanonicalValidationError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'BoqCanonicalValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BoqCanonicalValidationError(`${path} must be a non-empty string.`)
  }
  return value
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new BoqCanonicalValidationError(`${path} must be a string.`)
  }
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new BoqCanonicalValidationError(`${path} must be a boolean.`)
  }
}

function finiteNonNegative(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BoqCanonicalValidationError(`${path} must be a finite non-negative number.`)
  }
}

function optionalEnum(value: unknown, allowed: Set<string>, path: string): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.has(value))) {
    throw new BoqCanonicalValidationError(`${path} is invalid.`)
  }
}

function validateSourceRef(value: unknown, path: string): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)
  for (const field of ['page', 'table', 'row'] as const) finiteNonNegative(value[field], `${path}.${field}`)
}

function validateSourceCosts(value: unknown, path: string): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)
  for (const side of ['material', 'labour'] as const) {
    const cost = value[side]
    if (!isRecord(cost)) throw new BoqCanonicalValidationError(`${path}.${side} must be an object.`)
    if (typeof cost.present !== 'boolean') throw new BoqCanonicalValidationError(`${path}.${side}.present must be a boolean.`)
    nonEmptyString(cost.unit, `${path}.${side}.unit`)
    for (const field of ['qty', 'rate', 'total'] as const) finiteNonNegative(cost[field], `${path}.${side}.${field}`)
  }
}

function validateCostAllocation(value: unknown, path: string): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)
  optionalEnum(value.basis, COST_ALLOCATION_BASES, `${path}.basis`)
  optionalEnum(value.origin, COST_ALLOCATION_ORIGINS, `${path}.origin`)
  if (value.basis === undefined || value.origin === undefined) throw new BoqCanonicalValidationError(`${path} is invalid.`)
  finiteNonNegative(value.material, `${path}.material`)
  finiteNonNegative(value.labour, `${path}.labour`)
}

function parseItem(value: unknown, sectionIndex: number, itemIndex: number): BoqItem {
  const path = `sections[${sectionIndex}].items[${itemIndex}]`
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)

  nonEmptyString(value.desc, `${path}.desc`)
  optionalString(value.id, `${path}.id`)
  optionalString(value.code, `${path}.code`)
  optionalString(value.parentBundleId, `${path}.parentBundleId`)
  optionalString(value.exclusionReason, `${path}.exclusionReason`)
  optionalString(value.sourceRowId, `${path}.sourceRowId`)
  optionalString(value.stdExclusionReason, `${path}.stdExclusionReason`)
  optionalString(value.stdMatch, `${path}.stdMatch`)
  optionalString(value.stdId, `${path}.stdId`)
  optionalString(value.sourceDesc, `${path}.sourceDesc`)
  optionalString(value.sourceUnit, `${path}.sourceUnit`)
  optionalBoolean(value.optional, `${path}.optional`)
  optionalBoolean(value.excludedFromTotal, `${path}.excludedFromTotal`)
  optionalEnum(value.entryOrigin, ENTRY_ORIGINS, `${path}.entryOrigin`)
  optionalEnum(value.stdConfidence, STD_CONFIDENCES, `${path}.stdConfidence`)
  validateSourceRef(value.sourceRef, `${path}.sourceRef`)
  if (value.sourceRowIds !== undefined && (!Array.isArray(value.sourceRowIds) || value.sourceRowIds.some((id) => typeof id !== 'string'))) {
    throw new BoqCanonicalValidationError(`${path}.sourceRowIds must be an array of strings.`)
  }

  if (typeof value.stdStatus !== 'string' || !STD_STATUSES.has(value.stdStatus)) {
    throw new BoqCanonicalValidationError(`${path}.stdStatus is invalid.`)
  }
  if (value.pricingRole !== undefined && (typeof value.pricingRole !== 'string' || !PRICING_ROLES.has(value.pricingRole))) {
    throw new BoqCanonicalValidationError(`${path}.pricingRole is invalid.`)
  }
  if (value.excludedFromTotal === true && (
    value.optional !== true || typeof value.exclusionReason !== 'string' || value.exclusionReason.trim() === ''
  )) {
    throw new BoqCanonicalValidationError(`${path} excluded options require optional true and a non-empty exclusionReason.`)
  }

  if (value.pricingRole === 'bundle_child') {
    nonEmptyString(value.parentBundleId, `${path}.parentBundleId`)
    for (const field of ['unit', 'qty', 'rate', 'total', 'type'] as const) {
      if (Object.hasOwn(value, field)) {
        throw new BoqCanonicalValidationError(`${path}.${field} is not allowed for an informational bundle child.`)
      }
    }
    return { ...value } as unknown as BoqItem
  }

  nonEmptyString(value.unit, `${path}.unit`)
  finiteNonNegative(value.qty, `${path}.qty`)
  finiteNonNegative(value.rate, `${path}.rate`)
  finiteNonNegative(value.total, `${path}.total`)
  if (typeof value.type !== 'string' || !ITEM_TYPES.has(value.type)) {
    throw new BoqCanonicalValidationError(`${path}.type is invalid.`)
  }
  optionalEnum(value.costComponent, COST_COMPONENTS, `${path}.costComponent`)
  validateSourceCosts(value.sourceCosts, `${path}.sourceCosts`)
  validateCostAllocation(value.costAllocation, `${path}.costAllocation`)
  return { ...value } as unknown as BoqItem
}

export function parseCanonicalBoqSections(value: unknown): BoqSection[] {
  if (!Array.isArray(value)) throw new BoqCanonicalValidationError('sections must be an array.')

  return value.map((sectionValue, sectionIndex): BoqSection => {
    const path = `sections[${sectionIndex}]`
    if (!isRecord(sectionValue)) throw new BoqCanonicalValidationError(`${path} must be an object.`)
    const header = nonEmptyString(sectionValue.header, `${path}.header`)
    if (!Array.isArray(sectionValue.items)) throw new BoqCanonicalValidationError(`${path}.items must be an array.`)
    const items = sectionValue.items.map((item, itemIndex) => parseItem(item, sectionIndex, itemIndex))

    const bundleParents = new Set<string>()
    const seenIds = new Set<string>()
    items.forEach((item, itemIndex) => {
      if (!item.id) return
      if (seenIds.has(item.id)) throw new BoqCanonicalValidationError(`${path}.items[${itemIndex}].id must be unique within its section.`)
      seenIds.add(item.id)
      if (item.pricingRole === 'bundle_parent') bundleParents.add(item.id)
    })
    items.forEach((item, itemIndex) => {
      if (item.pricingRole === 'bundle_child' && !bundleParents.has(item.parentBundleId)) {
        throw new BoqCanonicalValidationError(`${path}.items[${itemIndex}].parentBundleId must reference a bundle parent in the same section.`)
      }
    })
    return { ...sectionValue, header, items } as BoqSection
  })
}
