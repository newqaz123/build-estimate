import {
  parseDecimalString,
  type DecimalString,
} from './decimal-string'

export type { DecimalString }

/**
 * Existing source location references remain the authority for raw evidence.
 * Projection contracts intentionally do not re-author client provenance fields.
 */
export type { BoqSourceRef } from './boq-schema'
export type { SourceCellRef } from './boq-extraction-cell-mapping'

export const ROW_ROLES = [
  'priced_item',
  'continuation',
  'section_header',
  'column_header',
  'note',
  'subtotal',
  'total',
  'tax',
  'amount_in_words',
  'blank_or_noise',
  'uncertain',
] as const

export type RowRole = (typeof ROW_ROLES)[number]

const ROW_ROLE_SET = new Set<string>(ROW_ROLES)

export interface ExtractedPricingSnapshot {
  description: string
  unit: string
  quantity: DecimalString
  materialRate: DecimalString
  labourRate: DecimalString
  total: DecimalString
}

export interface ReviewerPricingSnapshot {
  description: string
  unit: string
  quantity: DecimalString
  materialRate: DecimalString
  labourRate: DecimalString
  total: DecimalString
  correctionReason?: string
  confirmedAt: string
  confirmedBy: string
}

export interface PricingNormalization {
  catalogId: string
  catalogDescription: string
  catalogUnit: string
  ruleId: string
  catalogUnitsPerSourceUnit: DecimalString
  normalizedQuantity: DecimalString
  normalizedMaterialRate: DecimalString
  normalizedLabourRate: DecimalString
  normalizedTotal: DecimalString
}

export interface ProposedCatalogMetadata {
  description: string
  unit: string
  category?: string
  aliases: string[]
}

export interface SuggestionVersions {
  extractionFingerprint: string
  boqSectionsFingerprint: string
  catalogFingerprint: string
  conversionFingerprint: string
  promptVersion: string
  modelVersion?: string
}

class ActionableReviewTypeError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'ActionableReviewTypeError'
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ActionableReviewTypeError(`Invalid ${label}.`)
  }
  return value
}

/** Plain string field for preservation contracts; empty string is allowed. */
function plainString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ActionableReviewTypeError(`Invalid ${label}.`)
  }
  return value
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return nonEmptyString(value, label)
}

function requireKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ActionableReviewTypeError(`Invalid ${label}: unexpected key "${key}".`)
    }
  }
}

function parseDecimalField(value: unknown, label: string): DecimalString {
  try {
    return parseDecimalString(value)
  } catch {
    throw new ActionableReviewTypeError(`Invalid ${label}: must be a canonical decimal string.`)
  }
}

function parsePositiveConversionFactor(value: unknown, label: string): DecimalString {
  const parsed = parseDecimalField(value, label)
  if (parsed === '0' || parsed.startsWith('-')) {
    throw new ActionableReviewTypeError(`Invalid ${label}: conversion factor must be positive.`)
  }
  return parsed
}

const PRICING_KEYS = new Set([
  'description',
  'unit',
  'quantity',
  'materialRate',
  'labourRate',
  'total',
])

const REVIEWER_PRICING_KEYS = new Set([
  ...PRICING_KEYS,
  'correctionReason',
  'confirmedAt',
  'confirmedBy',
])

const NORMALIZATION_KEYS = new Set([
  'catalogId',
  'catalogDescription',
  'catalogUnit',
  'ruleId',
  'catalogUnitsPerSourceUnit',
  'normalizedQuantity',
  'normalizedMaterialRate',
  'normalizedLabourRate',
  'normalizedTotal',
])

const PROPOSED_CATALOG_KEYS = new Set([
  'description',
  'unit',
  'category',
  'aliases',
])

const SUGGESTION_VERSION_KEYS = new Set([
  'extractionFingerprint',
  'boqSectionsFingerprint',
  'catalogFingerprint',
  'conversionFingerprint',
  'promptVersion',
  'modelVersion',
])

export function parseRowRole(value: unknown): RowRole {
  if (typeof value !== 'string' || !ROW_ROLE_SET.has(value)) {
    throw new ActionableReviewTypeError('Invalid row role.')
  }
  return value as RowRole
}

export function parseSuggestionVersions(value: unknown): SuggestionVersions {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewTypeError('Invalid suggestion versions.')
  }
  requireKeys(value, SUGGESTION_VERSION_KEYS, 'suggestion versions')

  const parsed: SuggestionVersions = {
    extractionFingerprint: nonEmptyString(value.extractionFingerprint, 'extractionFingerprint'),
    boqSectionsFingerprint: nonEmptyString(value.boqSectionsFingerprint, 'boqSectionsFingerprint'),
    catalogFingerprint: nonEmptyString(value.catalogFingerprint, 'catalogFingerprint'),
    conversionFingerprint: nonEmptyString(value.conversionFingerprint, 'conversionFingerprint'),
    promptVersion: nonEmptyString(value.promptVersion, 'promptVersion'),
  }

  const modelVersion = optionalNonEmptyString(value.modelVersion, 'modelVersion')
  if (modelVersion !== undefined) {
    parsed.modelVersion = modelVersion
  }

  return parsed
}

function parseExtractedPricingFields(
  value: Record<string, unknown>,
  label: string,
): ExtractedPricingSnapshot {
  return {
    // Preservation contract: empty source description/unit are valid.
    description: plainString(value.description, `${label}.description`),
    unit: plainString(value.unit, `${label}.unit`),
    quantity: parseDecimalField(value.quantity, `${label}.quantity`),
    materialRate: parseDecimalField(value.materialRate, `${label}.materialRate`),
    labourRate: parseDecimalField(value.labourRate, `${label}.labourRate`),
    total: parseDecimalField(value.total, `${label}.total`),
  }
}

function parseReviewerPricingFields(
  value: Record<string, unknown>,
  label: string,
): Omit<ReviewerPricingSnapshot, 'correctionReason' | 'confirmedAt' | 'confirmedBy'> {
  return {
    description: plainString(value.description, `${label}.description`),
    unit: plainString(value.unit, `${label}.unit`),
    quantity: parseDecimalField(value.quantity, `${label}.quantity`),
    materialRate: parseDecimalField(value.materialRate, `${label}.materialRate`),
    labourRate: parseDecimalField(value.labourRate, `${label}.labourRate`),
    total: parseDecimalField(value.total, `${label}.total`),
  }
}

export function parseExtractedPricingSnapshot(value: unknown): ExtractedPricingSnapshot {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewTypeError('Invalid extracted pricing snapshot.')
  }
  requireKeys(value, PRICING_KEYS, 'extracted pricing snapshot')
  for (const key of PRICING_KEYS) {
    if (!(key in value)) {
      throw new ActionableReviewTypeError('Invalid extracted pricing snapshot.')
    }
  }
  return parseExtractedPricingFields(value, 'extracted pricing')
}

/**
 * Spec-gated fields: quantity, unit, material rate, labour rate, total.
 * Description-only edits do not require correctionReason.
 */
function pricingRequiresCorrection(
  reviewer: Omit<ReviewerPricingSnapshot, 'correctionReason' | 'confirmedAt' | 'confirmedBy'>,
  extracted: ExtractedPricingSnapshot,
): boolean {
  return reviewer.unit !== extracted.unit
    || reviewer.quantity !== extracted.quantity
    || reviewer.materialRate !== extracted.materialRate
    || reviewer.labourRate !== extracted.labourRate
    || reviewer.total !== extracted.total
}

/**
 * Reviewer-confirmed pricing used when a decision is applied.
 * Changes to quantity, unit, material rate, labour rate, or total require correctionReason.
 * Description-only edits do not.
 */
export function parseReviewerPricingSnapshot(
  value: unknown,
  extracted: ExtractedPricingSnapshot,
): ReviewerPricingSnapshot {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewTypeError('Invalid reviewer pricing snapshot.')
  }
  requireKeys(value, REVIEWER_PRICING_KEYS, 'reviewer pricing snapshot')
  for (const key of PRICING_KEYS) {
    if (!(key in value)) {
      throw new ActionableReviewTypeError('Invalid reviewer pricing snapshot.')
    }
  }

  // Canonicalize extracted decimals before divergence comparison so equivalent
  // spellings (e.g. 12.50 vs 12.5) are not treated as corrections.
  const canonicalExtracted = parseExtractedPricingSnapshot(extracted)
  const pricing = parseReviewerPricingFields(value, 'reviewer pricing')
  const confirmedAt = nonEmptyString(value.confirmedAt, 'confirmedAt')
  const confirmedBy = nonEmptyString(value.confirmedBy, 'confirmedBy')

  const needsCorrection = pricingRequiresCorrection(pricing, canonicalExtracted)
  const correctionReason = optionalNonEmptyString(value.correctionReason, 'correctionReason')

  if (needsCorrection && correctionReason === undefined) {
    throw new ActionableReviewTypeError(
      'Reviewer pricing divergence requires a non-empty correctionReason.',
    )
  }

  const parsed: ReviewerPricingSnapshot = {
    ...pricing,
    confirmedAt,
    confirmedBy,
  }
  if (correctionReason !== undefined) {
    parsed.correctionReason = correctionReason.trim()
  }
  return parsed
}

export function parsePricingNormalization(value: unknown): PricingNormalization {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewTypeError('Invalid pricing normalization.')
  }
  requireKeys(value, NORMALIZATION_KEYS, 'pricing normalization')
  for (const key of NORMALIZATION_KEYS) {
    if (!(key in value)) {
      throw new ActionableReviewTypeError('Invalid pricing normalization.')
    }
  }

  return {
    catalogId: nonEmptyString(value.catalogId, 'catalogId'),
    catalogDescription: nonEmptyString(value.catalogDescription, 'catalogDescription'),
    catalogUnit: nonEmptyString(value.catalogUnit, 'catalogUnit'),
    ruleId: nonEmptyString(value.ruleId, 'ruleId'),
    catalogUnitsPerSourceUnit: parsePositiveConversionFactor(
      value.catalogUnitsPerSourceUnit,
      'catalogUnitsPerSourceUnit',
    ),
    normalizedQuantity: parseDecimalField(value.normalizedQuantity, 'normalizedQuantity'),
    normalizedMaterialRate: parseDecimalField(value.normalizedMaterialRate, 'normalizedMaterialRate'),
    normalizedLabourRate: parseDecimalField(value.normalizedLabourRate, 'normalizedLabourRate'),
    normalizedTotal: parseDecimalField(value.normalizedTotal, 'normalizedTotal'),
  }
}

export function parseProposedCatalogMetadata(value: unknown): ProposedCatalogMetadata {
  if (!isPlainRecord(value)) {
    throw new ActionableReviewTypeError('Invalid proposed catalog metadata.')
  }
  requireKeys(value, PROPOSED_CATALOG_KEYS, 'proposed catalog metadata')
  if (!('description' in value) || !('unit' in value) || !('aliases' in value)) {
    throw new ActionableReviewTypeError('Invalid proposed catalog metadata.')
  }
  if (!Array.isArray(value.aliases)) {
    throw new ActionableReviewTypeError('Invalid proposed catalog metadata aliases.')
  }

  const aliases = value.aliases.map((alias, index) => {
    if (typeof alias !== 'string' || alias.trim() === '') {
      throw new ActionableReviewTypeError(`Invalid proposed catalog metadata alias at ${index}.`)
    }
    return alias
  })

  const parsed: ProposedCatalogMetadata = {
    description: nonEmptyString(value.description, 'description'),
    unit: nonEmptyString(value.unit, 'unit'),
    aliases,
  }

  const category = optionalNonEmptyString(value.category, 'category')
  if (category !== undefined) {
    parsed.category = category
  }

  return parsed
}
