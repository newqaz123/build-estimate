import { createHash } from 'node:crypto'

import type { ExtractionCandidateItem } from './boq-extraction-evidence'
import {
  BOQ_RECONCILIATION_TOLERANCE,
  type BoqSourceRowV3,
} from './boq-extraction-schema'

export interface SourceCellRef {
  sourceRowId: string
  column: number
  line?: number
}

export interface SourceCellMapping {
  sourceRowIds: string[]
  description?: SourceCellRef[]
  unit?: SourceCellRef
  quantity?: SourceCellRef
  rate?: SourceCellRef
  total?: SourceCellRef
  materialRate?: SourceCellRef
  materialTotal?: SourceCellRef
  labourRate?: SourceCellRef
  labourTotal?: SourceCellRef
  amount?: SourceCellRef
}

export type SourceMappingField =
  | 'description'
  | 'unit'
  | 'quantity'
  | 'rate'
  | 'total'
  | 'materialRate'
  | 'materialTotal'
  | 'labourRate'
  | 'labourTotal'
  | 'amount'

export interface SourceBackedResolvedValues {
  description?: string
  unit?: string
  quantity?: number
  rate?: number
  total?: number
  materialRate?: number
  materialTotal?: number
  labourRate?: number
  labourTotal?: number
  amount?: number
}

export interface SourceBackedReviewDraft {
  mapping: SourceCellMapping
  resolvedValues: SourceBackedResolvedValues
  missingFields: SourceMappingField[]
  sourceRowIds: string[]
  sourceRefs: Array<{ page: number; table: number; row: number }>
  section: { index: number; header: string }
}

export type SourceCellMappingFailureCode =
  | 'unknown_source_row'
  | 'missing_source_cell'
  | 'invalid_line_index'
  | 'conflicting_binding'
  | 'invalid_source_value'
  | 'arithmetic_mismatch'
  | 'component_sum_mismatch'

export type SourceMappingResolution =
  | { kind: 'candidate'; candidate: ExtractionCandidateItem; mapping: SourceCellMapping }
  | { kind: 'draft'; draft: SourceBackedReviewDraft }
  | { kind: 'invalid'; code: SourceCellMappingFailureCode }

interface ResolveSourceCellMappingArgs {
  mapping: SourceCellMapping
  allowedSourceRowIds: ReadonlySet<string>
  sourceRows: readonly BoqSourceRowV3[]
  section: { index: number; header: string }
}

const SINGLE_REF_FIELDS = [
  'unit',
  'quantity',
  'rate',
  'total',
  'materialRate',
  'materialTotal',
  'labourRate',
  'labourTotal',
  'amount',
] as const

const GENERIC_FIELDS: SourceMappingField[] = ['description', 'unit', 'quantity', 'rate', 'total']
const COMPONENT_FIELDS: SourceMappingField[] = [
  'description',
  'unit',
  'quantity',
  'materialRate',
  'materialTotal',
  'labourRate',
  'labourTotal',
  'amount',
]
const COMPONENT_PRICE_FIELDS = [
  'materialRate',
  'materialTotal',
  'labourRate',
  'labourTotal',
  'amount',
] as const

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function normalizedRef(ref: SourceCellRef): SourceCellRef {
  return {
    sourceRowId: ref.sourceRowId,
    column: ref.column,
    ...(ref.line === undefined ? {} : { line: ref.line }),
  }
}

function normalizeMapping(mapping: SourceCellMapping): SourceCellMapping {
  const normalized: SourceCellMapping = { sourceRowIds: [...mapping.sourceRowIds] }
  if (mapping.description !== undefined) normalized.description = mapping.description.map(normalizedRef)
  for (const field of SINGLE_REF_FIELDS) {
    const ref = mapping[field]
    if (ref !== undefined) normalized[field] = normalizedRef(ref)
  }
  return normalized
}

function allBindings(mapping: SourceCellMapping): Array<{ field: SourceMappingField; ref: SourceCellRef }> {
  const bindings: Array<{ field: SourceMappingField; ref: SourceCellRef }> = []
  for (const ref of mapping.description ?? []) bindings.push({ field: 'description', ref })
  for (const field of SINGLE_REF_FIELDS) {
    const ref = mapping[field]
    if (ref) bindings.push({ field, ref })
  }
  return bindings
}

const STRICT_NUMBER = /^(?:([A-Z]{3}|[$£¥฿€])\s*)?(\()?((?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)(\))?(?:\s*([A-Z]{3}))?$/

interface ExactDecimal {
  coefficient: bigint
  scale: number
}

const BIGINT_ZERO = BigInt(0)
const BIGINT_TEN = BigInt(10)

function normalizeDecimal(value: ExactDecimal): ExactDecimal {
  let { coefficient, scale } = value
  while (scale > 0 && coefficient % BIGINT_TEN === BIGINT_ZERO) {
    coefficient /= BIGINT_TEN
    scale -= 1
  }
  return { coefficient, scale }
}

function exactDecimalFromDigits(text: string): ExactDecimal {
  const [integer, fraction = ''] = text.split('.')
  return normalizeDecimal({
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  })
}

function exactDecimalFromNumber(value: number): ExactDecimal {
  const text = value.toString().toLowerCase()
  const [mantissa, exponentText] = text.split('e')
  const exponent = exponentText === undefined ? 0 : Number(exponentText)
  const point = mantissa.indexOf('.')
  const fractionDigits = point === -1 ? 0 : mantissa.length - point - 1
  const digits = mantissa.replace('.', '')
  let coefficient = BigInt(digits)
  let scale = fractionDigits - exponent
  if (scale < 0) {
    coefficient *= BIGINT_TEN ** BigInt(-scale)
    scale = 0
  }
  return normalizeDecimal({ coefficient, scale })
}

function alignDecimals(left: ExactDecimal, right: ExactDecimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale)
  return [
    left.coefficient * BIGINT_TEN ** BigInt(scale - left.scale),
    right.coefficient * BIGINT_TEN ** BigInt(scale - right.scale),
    scale,
  ]
}

function decimalsEqual(left: ExactDecimal, right: ExactDecimal): boolean {
  const [leftCoefficient, rightCoefficient] = alignDecimals(left, right)
  return leftCoefficient === rightCoefficient
}

function addDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const [leftCoefficient, rightCoefficient, scale] = alignDecimals(left, right)
  return normalizeDecimal({ coefficient: leftCoefficient + rightCoefficient, scale })
}

function multiplyDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return normalizeDecimal({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  })
}

const DECIMAL_TOLERANCE = exactDecimalFromNumber(BOQ_RECONCILIATION_TOLERANCE)

function decimalsApproximatelyEqual(left: ExactDecimal, right: ExactDecimal): boolean {
  const [leftCoefficient, rightCoefficient, scale] = alignDecimals(left, right)
  const difference = leftCoefficient < rightCoefficient
    ? rightCoefficient - leftCoefficient
    : leftCoefficient - rightCoefficient
  const [alignedDifference, alignedTolerance] = alignDecimals(
    { coefficient: difference, scale },
    DECIMAL_TOLERANCE,
  )
  return alignedDifference <= alignedTolerance
}

function exactDecimalToNumber(value: ExactDecimal): number | null {
  const parsed = Number(`${value.coefficient}e-${value.scale}`)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return decimalsEqual(value, exactDecimalFromNumber(parsed)) ? parsed : null
}

function parseSourceNumber(text: string): { number: number; decimal: ExactDecimal } | null {
  const match = STRICT_NUMBER.exec(text.trim())
  if (!match || (match[1] !== undefined && match[5] !== undefined) || Boolean(match[2]) !== Boolean(match[4])) return null
  if (match[2]) return null
  const decimal = exactDecimalFromDigits(match[3].replaceAll(',', ''))
  const parsed = exactDecimalToNumber(decimal)
  return parsed === null ? null : { number: parsed, decimal }
}

function sourceRefs(rows: readonly BoqSourceRowV3[], ids: readonly string[]) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.map((id) => byId.get(id)!).map((row) => ({ page: row.page, table: row.table, row: row.row }))
}

function invalid(code: SourceCellMappingFailureCode): SourceMappingResolution {
  return { kind: 'invalid', code }
}

/**
 * Reconstruct a mapped item exclusively from immutable Docling cells. The
 * mapping contributes coordinates only; no provider-authored value crosses
 * this boundary.
 */
export function resolveSourceCellMapping(input: ResolveSourceCellMappingArgs): SourceMappingResolution {
  const mapping = normalizeMapping(input.mapping)
  const rowsById = new Map(input.sourceRows.map((row) => [row.id, row]))
  if (mapping.sourceRowIds.length === 0
    || new Set(mapping.sourceRowIds).size !== mapping.sourceRowIds.length
    || mapping.sourceRowIds.some((id) => typeof id !== 'string' || id.trim() === '' || !input.allowedSourceRowIds.has(id) || !rowsById.has(id))) {
    return invalid('unknown_source_row')
  }

  const bindings = allBindings(mapping)
  if (bindings.some(({ ref }) => !mapping.sourceRowIds.includes(ref.sourceRowId)
    || !input.allowedSourceRowIds.has(ref.sourceRowId)
    || !rowsById.has(ref.sourceRowId))) {
    return invalid('unknown_source_row')
  }

  const hasGenericPrices = mapping.rate !== undefined || mapping.total !== undefined
  const hasComponentPrices = COMPONENT_PRICE_FIELDS.some((field) => mapping[field] !== undefined)
  if (hasGenericPrices && hasComponentPrices) return invalid('conflicting_binding')

  const refsByCell = new Map<string, SourceCellRef[]>()
  for (const { ref } of bindings) {
    if (!Number.isInteger(ref.column) || ref.column < 0) return invalid('missing_source_cell')
    if (ref.line !== undefined && (!Number.isInteger(ref.line) || ref.line < 0)) return invalid('invalid_line_index')
    const cellKey = `${ref.sourceRowId}:${ref.column}`
    const overlaps = (refsByCell.get(cellKey) ?? []).some((existing) =>
      existing.line === undefined || ref.line === undefined || existing.line === ref.line)
    if (overlaps) return invalid('conflicting_binding')
    refsByCell.set(cellKey, [...(refsByCell.get(cellKey) ?? []), ref])
  }

  const evidence: Array<{
    field: SourceMappingField
    ref: SourceCellRef
    text: string
    sourceRef: { page: number; table: number; row: number }
    retainedCell: BoqSourceRowV3['rawCells'][number]
  }> = []
  for (const binding of bindings) {
    const row = rowsById.get(binding.ref.sourceRowId)!
    const cells = row.rawCells.filter((cell) => cell.column === binding.ref.column)
    if (cells.length === 0) return invalid('missing_source_cell')
    if (cells.length > 1) return invalid('conflicting_binding')
    const cell = cells[0]
    if (binding.ref.line !== undefined && binding.ref.line >= cell.lines.length) return invalid('invalid_line_index')
    const text = binding.ref.line === undefined ? cell.rawText : cell.lines[binding.ref.line]
    if (typeof text !== 'string' || text.trim() === '') return invalid('invalid_source_value')
    evidence.push({
      ...binding,
      text: text.trim(),
      sourceRef: { page: row.page, table: row.table, row: row.row },
      retainedCell: structuredClone(cell),
    })
  }

  const resolvedValues: SourceBackedResolvedValues = {}
  const resolvedDecimals: Partial<Record<Exclude<SourceMappingField, 'description' | 'unit'>, ExactDecimal>> = {}
  const descriptions = evidence.filter((item) => item.field === 'description').map((item) => item.text)
  if (descriptions.length > 0) resolvedValues.description = descriptions.join('\n')
  const unit = evidence.find((item) => item.field === 'unit')
  if (unit) resolvedValues.unit = unit.text
  for (const field of ['quantity', 'rate', 'total', ...COMPONENT_PRICE_FIELDS] as const) {
    const item = evidence.find((entry) => entry.field === field)
    if (!item) continue
    const parsed = parseSourceNumber(item.text)
    if (parsed === null) return invalid('invalid_source_value')
    resolvedValues[field] = parsed.number
    resolvedDecimals[field] = parsed.decimal
  }

  const requiredFields = hasComponentPrices ? COMPONENT_FIELDS : GENERIC_FIELDS
  const missingFields = requiredFields.filter((field) => {
    if (field === 'description') return !resolvedValues.description
    return resolvedValues[field] === undefined
  })
  const refs = sourceRefs(input.sourceRows, mapping.sourceRowIds)
  if (missingFields.length > 0) {
    return {
      kind: 'draft',
      draft: {
        mapping,
        resolvedValues,
        missingFields,
        sourceRowIds: [...mapping.sourceRowIds],
        sourceRefs: refs,
        section: { ...input.section },
      },
    }
  }

  const qty = resolvedValues.quantity!
  let rate: number
  let total: number
  let sourceCosts: ExtractionCandidateItem['sourceCosts'] = null
  if (hasComponentPrices) {
    const materialRate = resolvedValues.materialRate!
    const materialTotal = resolvedValues.materialTotal!
    const labourRate = resolvedValues.labourRate!
    const labourTotal = resolvedValues.labourTotal!
    total = resolvedValues.amount!
    const quantityDecimal = resolvedDecimals.quantity!
    const materialRateDecimal = resolvedDecimals.materialRate!
    const materialTotalDecimal = resolvedDecimals.materialTotal!
    const labourRateDecimal = resolvedDecimals.labourRate!
    const labourTotalDecimal = resolvedDecimals.labourTotal!
    const amountDecimal = resolvedDecimals.amount!
    if (!decimalsApproximatelyEqual(multiplyDecimals(quantityDecimal, materialRateDecimal), materialTotalDecimal)
      || !decimalsApproximatelyEqual(multiplyDecimals(quantityDecimal, labourRateDecimal), labourTotalDecimal)) {
      return invalid('arithmetic_mismatch')
    }
    const combinedTotalDecimal = addDecimals(materialTotalDecimal, labourTotalDecimal)
    if (!decimalsApproximatelyEqual(combinedTotalDecimal, amountDecimal)) return invalid('component_sum_mismatch')
    const combinedRateDecimal = addDecimals(materialRateDecimal, labourRateDecimal)
    const combinedRate = exactDecimalToNumber(combinedRateDecimal)
    if (combinedRate === null) return invalid('invalid_source_value')
    rate = combinedRate
    if (!decimalsApproximatelyEqual(multiplyDecimals(quantityDecimal, combinedRateDecimal), amountDecimal)) {
      return invalid('arithmetic_mismatch')
    }
    sourceCosts = {
      material: { qty, unit: resolvedValues.unit!, rate: materialRate, total: materialTotal },
      labour: { qty, unit: resolvedValues.unit!, rate: labourRate, total: labourTotal },
    }
  } else {
    rate = resolvedValues.rate!
    total = resolvedValues.total!
    if (!decimalsApproximatelyEqual(
      multiplyDecimals(resolvedDecimals.quantity!, resolvedDecimals.rate!),
      resolvedDecimals.total!,
    )) return invalid('arithmetic_mismatch')
  }

  const evidenceFingerprint = createHash('sha256').update(stableJson(evidence)).digest('hex')
  const idFingerprint = createHash('sha256').update(stableJson({ mapping, evidenceFingerprint })).digest('hex')
  const orderedRows = [...input.sourceRows]
    .sort((left, right) => left.page - right.page || left.table - right.table || left.row - right.row || left.id.localeCompare(right.id))
  const sourceIndexes = new Map(orderedRows.map((row, index) => [row.id, index]))
  const physicalOrder = Math.min(...mapping.sourceRowIds.map((id) => sourceIndexes.get(id)!))
  const candidate: ExtractionCandidateItem = {
    id: `mapped-${idFingerprint.slice(0, 32)}`,
    sectionIndex: input.section.index,
    sectionHeader: input.section.header,
    sourceOrder: physicalOrder,
    sourceRowIds: [...mapping.sourceRowIds],
    sourceRefs: refs,
    desc: resolvedValues.description!,
    pricingRole: 'standard',
    parentBundleId: null,
    unit: resolvedValues.unit!,
    qty,
    rate,
    total,
    costComponent: 'combined',
    sourceCosts,
    optional: false,
    excludedFromTotal: false,
    exclusionReason: null,
  }
  return { kind: 'candidate', candidate, mapping }
}
