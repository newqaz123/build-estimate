import type {
  PricingNormalization,
  ReviewerPricingSnapshot,
} from './actionable-review-types'
import {
  addDecimal,
  divideDecimalExact,
  equalAtMinorUnit,
  multiplyDecimal,
  parseDecimalString,
  type DecimalString,
} from './decimal-string'

export type { DecimalString }

/** Intermediate fractional digits for component-rate division before canonicalization. */
const COMPONENT_RATE_SCALE = 6

export interface HumanApprovedCatalogConversionRule {
  id: string
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: DecimalString
  scope: 'global' | 'catalog_item'
  catalogId?: string
  version: number
  approvedBy: string
  approvedAt: string
  archivedAt?: string
}

export interface IdentityCatalogConversionRule {
  id: string
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: '1'
  scope: 'identity'
  version: 1
}

export type CatalogConversionRule =
  | HumanApprovedCatalogConversionRule
  | IdentityCatalogConversionRule

export const IDENTITY_CONVERSION_RULE_VERSION = 1 as const

export class CatalogConversionError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CatalogConversionError'
    this.status = status
  }
}

function nonEmptyTrimmed(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogConversionError(`Invalid ${label}.`)
  }
  return value.trim()
}

/**
 * System identity rule for canonically equal units.
 * Generated in code only — never stored or accepted as a human approval document.
 */
export function identityConversionRule(canonicalUnit: string): IdentityCatalogConversionRule {
  const unit = nonEmptyTrimmed(canonicalUnit, 'canonicalUnit')
  return {
    id: `identity:${unit}:v${IDENTITY_CONVERSION_RULE_VERSION}`,
    sourceUnit: unit,
    catalogUnit: unit,
    catalogUnitsPerSourceUnit: '1',
    scope: 'identity',
    version: IDENTITY_CONVERSION_RULE_VERSION,
  }
}

function parsePositiveFactor(value: unknown): DecimalString {
  let parsed: DecimalString
  try {
    parsed = parseDecimalString(value)
  } catch {
    throw new CatalogConversionError('Invalid conversion factor.')
  }
  if (parsed === '0' || parsed.startsWith('-')) {
    throw new CatalogConversionError('Conversion factor must be positive.')
  }
  return parsed
}

function assertRuleUnits(
  source: ReviewerPricingSnapshot,
  catalogUnit: string,
  rule: CatalogConversionRule,
): void {
  if (source.unit !== rule.sourceUnit) {
    throw new CatalogConversionError('Source unit does not match conversion rule.')
  }
  if (catalogUnit !== rule.catalogUnit) {
    throw new CatalogConversionError('Catalog unit does not match conversion rule.')
  }
}

function assertHumanRuleActive(
  rule: HumanApprovedCatalogConversionRule,
  catalogId: string,
): void {
  if (rule.archivedAt !== undefined) {
    throw new CatalogConversionError('Archived conversion rules cannot normalize pricing.')
  }
  if (rule.scope === 'global') {
    if (rule.catalogId !== undefined) {
      throw new CatalogConversionError('Global conversion rules must not include catalogId.')
    }
    return
  }
  if (rule.scope === 'catalog_item') {
    if (typeof rule.catalogId !== 'string' || rule.catalogId.trim() === '') {
      throw new CatalogConversionError('Catalog-item conversion rules require catalogId.')
    }
    if (rule.catalogId !== catalogId) {
      throw new CatalogConversionError('Conversion rule catalogId does not match target catalog item.')
    }
    return
  }
  throw new CatalogConversionError('Invalid conversion rule scope.')
}

function assertIdentityRule(
  source: ReviewerPricingSnapshot,
  catalogUnit: string,
  rule: IdentityCatalogConversionRule,
): void {
  if (rule.catalogUnitsPerSourceUnit !== '1') {
    throw new CatalogConversionError('Identity conversion rules must use factor 1.')
  }
  if (rule.version !== IDENTITY_CONVERSION_RULE_VERSION) {
    throw new CatalogConversionError('Invalid identity conversion rule version.')
  }
  if (rule.sourceUnit !== rule.catalogUnit) {
    throw new CatalogConversionError('Identity conversion rules require equal units.')
  }
  if (source.unit !== rule.sourceUnit || catalogUnit !== rule.catalogUnit) {
    throw new CatalogConversionError(
      'Identity conversion requires canonically equal source and catalog units.',
    )
  }
  if (source.unit !== catalogUnit) {
    throw new CatalogConversionError(
      'Identity conversion requires canonically equal source and catalog units.',
    )
  }
}

/**
 * Normalize reviewer-confirmed pricing through an allowlisted conversion rule.
 * Uses exact decimal arithmetic only; never floating-point.
 */
export function normalizePricingWithRule(input: {
  source: ReviewerPricingSnapshot
  catalogId: string
  catalogDescription: string
  catalogUnit: string
  rule: CatalogConversionRule
  currencyScale: number
}): PricingNormalization {
  const catalogId = nonEmptyTrimmed(input.catalogId, 'catalogId')
  const catalogDescription = nonEmptyTrimmed(input.catalogDescription, 'catalogDescription')
  const catalogUnit = nonEmptyTrimmed(input.catalogUnit, 'catalogUnit')

  if (
    typeof input.currencyScale !== 'number'
    || !Number.isInteger(input.currencyScale)
    || input.currencyScale < 0
  ) {
    throw new CatalogConversionError('Currency scale must be a non-negative integer.')
  }

  const { source, rule } = input
  assertRuleUnits(source, catalogUnit, rule)

  if (rule.scope === 'identity') {
    assertIdentityRule(source, catalogUnit, rule)
  } else {
    assertHumanRuleActive(rule, catalogId)
  }

  const factor = parsePositiveFactor(rule.catalogUnitsPerSourceUnit)

  const normalizedQuantity = multiplyDecimal(source.quantity, factor)
  const normalizedMaterialRate = divideDecimalExact(
    source.materialRate,
    factor,
    COMPONENT_RATE_SCALE,
  )
  const normalizedLabourRate = divideDecimalExact(
    source.labourRate,
    factor,
    COMPONENT_RATE_SCALE,
  )
  const combinedRate = addDecimal(normalizedMaterialRate, normalizedLabourRate)
  const normalizedTotal = multiplyDecimal(normalizedQuantity, combinedRate)

  if (!equalAtMinorUnit(source.total, normalizedTotal, input.currencyScale)) {
    throw new CatalogConversionError(
      'Reviewer-confirmed and normalized totals must agree at currency minor-unit precision.',
    )
  }

  return {
    catalogId,
    catalogDescription,
    catalogUnit,
    ruleId: rule.id,
    catalogUnitsPerSourceUnit: factor,
    normalizedQuantity,
    normalizedMaterialRate,
    normalizedLabourRate,
    normalizedTotal,
  }
}
