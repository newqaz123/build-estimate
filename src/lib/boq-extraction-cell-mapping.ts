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

function approximatelyEqual(left: number, right: number): boolean {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= BOQ_RECONCILIATION_TOLERANCE
}

const STRICT_NUMBER = /^(?:([A-Z]{3}|[$£¥฿€])\s*)?(\()?((?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)(\))?(?:\s*([A-Z]{3}))?$/

function parseSourceNumber(text: string): number | null {
  const match = STRICT_NUMBER.exec(text.trim())
  if (!match || (match[1] !== undefined && match[5] !== undefined) || Boolean(match[2]) !== Boolean(match[4])) return null
  const unsigned = Number(match[3].replaceAll(',', ''))
  const parsed = match[2] ? -unsigned : unsigned
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
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
  const descriptions = evidence.filter((item) => item.field === 'description').map((item) => item.text)
  if (descriptions.length > 0) resolvedValues.description = descriptions.join('\n')
  const unit = evidence.find((item) => item.field === 'unit')
  if (unit) resolvedValues.unit = unit.text
  for (const field of ['quantity', 'rate', 'total', ...COMPONENT_PRICE_FIELDS] as const) {
    const item = evidence.find((entry) => entry.field === field)
    if (!item) continue
    const value = parseSourceNumber(item.text)
    if (value === null) return invalid('invalid_source_value')
    resolvedValues[field] = value
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
    if (!approximatelyEqual(qty * materialRate, materialTotal)
      || !approximatelyEqual(qty * labourRate, labourTotal)) return invalid('arithmetic_mismatch')
    if (!approximatelyEqual(materialTotal + labourTotal, total)) return invalid('component_sum_mismatch')
    rate = materialRate + labourRate
    if (!approximatelyEqual(qty * rate, total)) return invalid('arithmetic_mismatch')
    sourceCosts = {
      material: { qty, unit: resolvedValues.unit!, rate: materialRate, total: materialTotal },
      labour: { qty, unit: resolvedValues.unit!, rate: labourRate, total: labourTotal },
    }
  } else {
    rate = resolvedValues.rate!
    total = resolvedValues.total!
    if (!approximatelyEqual(qty * rate, total)) return invalid('arithmetic_mismatch')
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
