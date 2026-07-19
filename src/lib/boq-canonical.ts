import type {
  BoqCostAllocation,
  BoqExtractionWarning,
  BoqItem,
  BoqSection,
  BoqSourceCosts,
  BoqSourceRef,
} from './boq-schema'

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

function optionalString(value: unknown, path: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new BoqCanonicalValidationError(`${path} must be a string.`)
  }
  return value
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new BoqCanonicalValidationError(`${path} must be a boolean.`)
  }
  return value
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BoqCanonicalValidationError(`${path} must be a finite non-negative number.`)
  }
  return value
}

function optionalEnum<T extends string>(value: unknown, allowed: Set<string>, path: string): T | undefined {
  if (value !== undefined && (typeof value !== 'string' || !allowed.has(value))) {
    throw new BoqCanonicalValidationError(`${path} is invalid.`)
  }
  return value as T | undefined
}

function parseSourceRef(value: unknown, path: string): BoqSourceRef | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)
  return {
    page: finiteNonNegative(value.page, `${path}.page`),
    table: finiteNonNegative(value.table, `${path}.table`),
    row: finiteNonNegative(value.row, `${path}.row`),
  }
}

function parseExtractionWarnings(value: unknown, path: string): BoqExtractionWarning[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new BoqCanonicalValidationError(`${path} must be an array.`)
  return value.map((warning, index) => {
    const warningPath = `${path}[${index}]`
    if (!isRecord(warning)) throw new BoqCanonicalValidationError(`${warningPath} must be an object.`)
    const sourceRef = parseSourceRef(warning.sourceRef, `${warningPath}.sourceRef`)
    return {
      code: nonEmptyString(warning.code, `${warningPath}.code`),
      message: nonEmptyString(warning.message, `${warningPath}.message`),
      ...(sourceRef ? { sourceRef } : {}),
    }
  })
}

function parseSourceCosts(value: unknown, path: string): BoqSourceCosts | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)
  const parsed = {} as BoqSourceCosts
  for (const side of ['material', 'labour'] as const) {
    const cost = value[side]
    if (!isRecord(cost)) throw new BoqCanonicalValidationError(`${path}.${side} must be an object.`)
    if (typeof cost.present !== 'boolean') throw new BoqCanonicalValidationError(`${path}.${side}.present must be a boolean.`)
    if (typeof cost.unit !== 'string' || (cost.present && cost.unit.trim() === '')) {
      throw new BoqCanonicalValidationError(`${path}.${side}.unit must be a non-empty string when present is true.`)
    }
    parsed[side] = {
      present: cost.present,
      unit: cost.unit,
      qty: finiteNonNegative(cost.qty, `${path}.${side}.qty`),
      rate: finiteNonNegative(cost.rate, `${path}.${side}.rate`),
      total: finiteNonNegative(cost.total, `${path}.${side}.total`),
    }
  }
  return parsed
}

function parseCostAllocation(value: unknown, path: string): BoqCostAllocation | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)
  const basis = optionalEnum<'rate' | 'total'>(value.basis, COST_ALLOCATION_BASES, `${path}.basis`)
  const origin = optionalEnum<'source' | 'manual'>(value.origin, COST_ALLOCATION_ORIGINS, `${path}.origin`)
  if (basis === undefined || origin === undefined) throw new BoqCanonicalValidationError(`${path} is invalid.`)
  return {
    basis,
    origin,
    material: finiteNonNegative(value.material, `${path}.material`),
    labour: finiteNonNegative(value.labour, `${path}.labour`),
  }
}

function setDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value
}

function parseItem(value: unknown, sectionIndex: number, itemIndex: number): BoqItem {
  const path = `sections[${sectionIndex}].items[${itemIndex}]`
  if (!isRecord(value)) throw new BoqCanonicalValidationError(`${path} must be an object.`)

  const stdStatus = optionalEnum<BoqItem['stdStatus']>(value.stdStatus, STD_STATUSES, `${path}.stdStatus`)
  if (stdStatus === undefined) throw new BoqCanonicalValidationError(`${path}.stdStatus is invalid.`)
  const common: Record<string, unknown> = {
    desc: nonEmptyString(value.desc, `${path}.desc`),
    stdStatus,
  }
  setDefined(common, 'id', optionalString(value.id, `${path}.id`))
  setDefined(common, 'code', optionalString(value.code, `${path}.code`))
  setDefined(common, 'parentBundleId', optionalString(value.parentBundleId, `${path}.parentBundleId`))
  setDefined(common, 'exclusionReason', optionalString(value.exclusionReason, `${path}.exclusionReason`))
  setDefined(common, 'sourceRowId', optionalString(value.sourceRowId, `${path}.sourceRowId`))
  setDefined(common, 'stdExclusionReason', optionalString(value.stdExclusionReason, `${path}.stdExclusionReason`))
  setDefined(common, 'stdMatch', optionalString(value.stdMatch, `${path}.stdMatch`))
  setDefined(common, 'stdId', optionalString(value.stdId, `${path}.stdId`))
  setDefined(common, 'sourceDesc', optionalString(value.sourceDesc, `${path}.sourceDesc`))
  setDefined(common, 'sourceUnit', optionalString(value.sourceUnit, `${path}.sourceUnit`))
  setDefined(common, 'optional', optionalBoolean(value.optional, `${path}.optional`))
  setDefined(common, 'excludedFromTotal', optionalBoolean(value.excludedFromTotal, `${path}.excludedFromTotal`))
  setDefined(common, 'entryOrigin', optionalEnum(value.entryOrigin, ENTRY_ORIGINS, `${path}.entryOrigin`))
  setDefined(common, 'stdConfidence', optionalEnum(value.stdConfidence, STD_CONFIDENCES, `${path}.stdConfidence`))
  setDefined(common, 'sourceRef', parseSourceRef(value.sourceRef, `${path}.sourceRef`))
  setDefined(common, 'extractionWarnings', parseExtractionWarnings(value.extractionWarnings, `${path}.extractionWarnings`))
  if (value.sourceRowIds !== undefined && (!Array.isArray(value.sourceRowIds) || value.sourceRowIds.some((id) => typeof id !== 'string'))) {
    throw new BoqCanonicalValidationError(`${path}.sourceRowIds must be an array of strings.`)
  }
  if (value.sourceRowIds !== undefined) common.sourceRowIds = [...value.sourceRowIds]

  const pricingRole = optionalEnum<NonNullable<BoqItem['pricingRole']>>(value.pricingRole, PRICING_ROLES, `${path}.pricingRole`)
  if (value.excludedFromTotal === true && (
    value.optional !== true || typeof value.exclusionReason !== 'string' || value.exclusionReason.trim() === ''
  )) {
    throw new BoqCanonicalValidationError(`${path} excluded options require optional true and a non-empty exclusionReason.`)
  }

  if (pricingRole === 'bundle_child') {
    const parentBundleId = nonEmptyString(value.parentBundleId, `${path}.parentBundleId`)
    for (const field of ['unit', 'qty', 'rate', 'total', 'type', 'costComponent', 'sourceCosts', 'costAllocation'] as const) {
      if (Object.hasOwn(value, field)) {
        throw new BoqCanonicalValidationError(`${path}.${field} is not allowed for an informational bundle child.`)
      }
    }
    return { ...common, pricingRole, parentBundleId } as unknown as BoqItem
  }

  const type = optionalEnum<'unit' | 'lump_sum' | 'job'>(value.type, ITEM_TYPES, `${path}.type`)
  if (type === undefined) throw new BoqCanonicalValidationError(`${path}.type is invalid.`)
  const priced: Record<string, unknown> = {
    ...common,
    unit: nonEmptyString(value.unit, `${path}.unit`),
    qty: finiteNonNegative(value.qty, `${path}.qty`),
    rate: finiteNonNegative(value.rate, `${path}.rate`),
    total: finiteNonNegative(value.total, `${path}.total`),
    type,
  }
  setDefined(priced, 'pricingRole', pricingRole)
  setDefined(priced, 'costComponent', optionalEnum(value.costComponent, COST_COMPONENTS, `${path}.costComponent`))
  setDefined(priced, 'sourceCosts', parseSourceCosts(value.sourceCosts, `${path}.sourceCosts`))
  setDefined(priced, 'costAllocation', parseCostAllocation(value.costAllocation, `${path}.costAllocation`))
  return priced as unknown as BoqItem
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
    return { header, items }
  })
}
