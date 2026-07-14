import type {
  Boq,
  BoqExtractionWarning,
  BoqItem,
  BoqMetadataConfidence,
  BoqSourceCost,
  BoqSourceCosts,
  BoqSourceRef,
  WorkType,
} from './boq-schema'

const WORK_TYPES: readonly WorkType[] = ['Structural', 'MEP', 'Finishing', 'Unclassified']
const ITEM_TYPES = ['unit', 'lump_sum'] as const
const COST_COMPONENTS = ['material', 'labour', 'combined', 'lump_sum'] as const
const TOLERANCE = 0.01

type DoclingItemType = typeof ITEM_TYPES[number]
type CostComponent = typeof COST_COMPONENTS[number]

export interface DoclingMetadataField<T extends string = string> {
  value: T
  confidence: number
  source: string
}

export interface DoclingMetadata {
  vendor: DoclingMetadataField
  project: DoclingMetadataField
  date: DoclingMetadataField
  workType: DoclingMetadataField<WorkType>
}

export interface DoclingItem {
  id: string
  code?: string | null
  desc: string
  unit: string
  qty: number
  rate: number
  total: number
  type: DoclingItemType
  costComponent: CostComponent
  sourceRef: BoqSourceRef
  sourceCosts?: BoqSourceCosts | null
}

export interface DoclingSection {
  header: string
  items: DoclingItem[]
}

export interface DoclingRawTable {
  page: number
  table: number
  rows: unknown[][]
}

export interface DoclingResultV2 {
  contractVersion: 2
  documentName: string
  pageCount: number
  documentText: string
  tables: DoclingRawTable[]
  sections: DoclingSection[]
  metadata: DoclingMetadata
  warnings: Array<BoqExtractionWarning & { sourceRef?: BoqSourceRef | null }>
  sourceTotal?: number | null
  totalItems: number
}

export type VerificationIssueCode =
  | 'metadata_missing'
  | 'items_missing'
  | 'invalid_number'
  | 'line_total_mismatch'
  | 'grand_total_mismatch'
  | 'document_total_mismatch'

export interface VerificationIssue {
  code: VerificationIssueCode
  severity: 'blocking' | 'warning'
  message: string
  sectionIndex?: number
  itemIndex?: number
  itemId?: string
}

export interface VerificationResult {
  issues: VerificationIssue[]
  hasBlockingIssues: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(path: string, expectation: string): never {
  throw new TypeError(`Invalid Docling result: ${path} must be ${expectation}`)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, 'an object')
  return value
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'an array')
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path, 'a string')
  return value
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'a finite number')
  return value
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path)
  if (!Number.isInteger(number) || number < 0) invalid(path, 'a non-negative integer')
  return number
}

function requirePositiveInteger(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path)
  if (!Number.isInteger(number) || number <= 0) invalid(path, 'a positive integer')
  return number
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    invalid(path, `one of ${allowed.join(', ')}`)
  }
  return value as T
}

function validateSourceRef(value: unknown, path: string): BoqSourceRef {
  const record = requireRecord(value, path)
  requirePositiveInteger(record.page, `${path}.page`)
  requirePositiveInteger(record.table, `${path}.table`)
  requirePositiveInteger(record.row, `${path}.row`)
  return record as unknown as BoqSourceRef
}

function validateSourceCost(value: unknown, path: string): BoqSourceCost {
  const record = requireRecord(value, path)
  if (typeof record.present !== 'boolean') invalid(`${path}.present`, 'a boolean')
  requireFiniteNumber(record.qty, `${path}.qty`)
  requireString(record.unit, `${path}.unit`)
  requireFiniteNumber(record.rate, `${path}.rate`)
  requireFiniteNumber(record.total, `${path}.total`)
  return record as unknown as BoqSourceCost
}

function validateSourceCosts(value: unknown, path: string): BoqSourceCosts {
  const record = requireRecord(value, path)
  validateSourceCost(record.material, `${path}.material`)
  validateSourceCost(record.labour, `${path}.labour`)
  return record as unknown as BoqSourceCosts
}

function validateMetadataField(value: unknown, path: string, workType = false): void {
  const record = requireRecord(value, path)
  if (workType) requireEnum(record.value, WORK_TYPES, `${path}.value`)
  else requireString(record.value, `${path}.value`)
  const confidence = requireFiniteNumber(record.confidence, `${path}.confidence`)
  if (confidence < 0 || confidence > 1) invalid(`${path}.confidence`, 'between 0 and 1')
  requireString(record.source, `${path}.source`)
}

function validateItem(value: unknown, path: string): void {
  const record = requireRecord(value, path)
  const id = requireString(record.id, `${path}.id`)
  if (id.trim() === '') invalid(`${path}.id`, 'a non-empty string')
  if (record.code !== undefined && record.code !== null) requireString(record.code, `${path}.code`)
  requireString(record.desc, `${path}.desc`)
  requireString(record.unit, `${path}.unit`)
  requireFiniteNumber(record.qty, `${path}.qty`)
  requireFiniteNumber(record.rate, `${path}.rate`)
  requireFiniteNumber(record.total, `${path}.total`)
  requireEnum(record.type, ITEM_TYPES, `${path}.type`)
  requireEnum(record.costComponent, COST_COMPONENTS, `${path}.costComponent`)
  validateSourceRef(record.sourceRef, `${path}.sourceRef`)
  if (record.sourceCosts !== undefined && record.sourceCosts !== null) {
    validateSourceCosts(record.sourceCosts, `${path}.sourceCosts`)
  }
}

function validateWarning(value: unknown, path: string): void {
  const record = requireRecord(value, path)
  requireString(record.code, `${path}.code`)
  requireString(record.message, `${path}.message`)
  if (record.sourceRef !== undefined && record.sourceRef !== null) {
    validateSourceRef(record.sourceRef, `${path}.sourceRef`)
  }
}

export function parseDoclingResult(value: unknown): DoclingResultV2 {
  const result = requireRecord(value, 'result')
  if (result.contractVersion !== 2) invalid('contractVersion', 'exactly 2')
  requireString(result.documentName, 'documentName')
  requireNonNegativeInteger(result.pageCount, 'pageCount')
  requireString(result.documentText, 'documentText')

  requireArray(result.tables, 'tables').forEach((table, tableIndex) => {
    const record = requireRecord(table, `tables[${tableIndex}]`)
    requireNonNegativeInteger(record.page, `tables[${tableIndex}].page`)
    requireNonNegativeInteger(record.table, `tables[${tableIndex}].table`)
    requireArray(record.rows, `tables[${tableIndex}].rows`).forEach((row, rowIndex) => {
      requireArray(row, `tables[${tableIndex}].rows[${rowIndex}]`)
    })
  })

  requireArray(result.sections, 'sections').forEach((section, sectionIndex) => {
    const record = requireRecord(section, `sections[${sectionIndex}]`)
    requireString(record.header, `sections[${sectionIndex}].header`)
    requireArray(record.items, `sections[${sectionIndex}].items`).forEach((item, itemIndex) => {
      validateItem(item, `sections[${sectionIndex}].items[${itemIndex}]`)
    })
  })

  const metadata = requireRecord(result.metadata, 'metadata')
  validateMetadataField(metadata.vendor, 'metadata.vendor')
  validateMetadataField(metadata.project, 'metadata.project')
  validateMetadataField(metadata.date, 'metadata.date')
  validateMetadataField(metadata.workType, 'metadata.workType', true)
  requireArray(result.warnings, 'warnings').forEach((warning, index) => validateWarning(warning, `warnings[${index}]`))
  if (result.sourceTotal !== undefined && result.sourceTotal !== null) {
    requireFiniteNumber(result.sourceTotal, 'sourceTotal')
  }
  requireNonNegativeInteger(result.totalItems, 'totalItems')

  return result as unknown as DoclingResultV2
}

export function buildDraftBoq(
  id: string,
  sourcePath: string,
  parsed: DoclingResultV2,
): Omit<Boq, 'createdAt' | 'updatedAt'> {
  const sections = parsed.sections.map((section) => ({
    header: section.header,
    items: section.items.map((item): BoqItem => ({
      id: item.id,
      code: item.code ?? '',
      desc: item.desc,
      unit: item.unit,
      qty: item.qty,
      rate: item.rate,
      total: item.total,
      type: item.type,
      costComponent: item.costComponent,
      sourceRef: item.sourceRef,
      ...(item.sourceCosts ? { sourceCosts: item.sourceCosts } : {}),
      stdStatus: 'unmatched',
    })),
  }))
  const items = sections.flatMap((section) => section.items)
  const metadataConfidence: BoqMetadataConfidence = {
    vendor: parsed.metadata.vendor.confidence,
    project: parsed.metadata.project.confidence,
    date: parsed.metadata.date.confidence,
    workType: parsed.metadata.workType.confidence,
  }

  return {
    id,
    project: parsed.metadata.project.value,
    vendor: parsed.metadata.vendor.value,
    workType: parsed.metadata.workType.value,
    date: parsed.metadata.date.value,
    totalItems: items.length,
    grandTotal: items.reduce((sum, item) => sum + item.total, 0),
    status: 'draft',
    stdStatus: 'none',
    sections,
    sourceFileName: parsed.documentName,
    sourceStoragePath: sourcePath,
    sourcePageCount: parsed.pageCount,
    ...(typeof parsed.sourceTotal === 'number' ? { sourceTotal: parsed.sourceTotal } : {}),
    extractionWarnings: parsed.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.sourceRef ? { sourceRef: warning.sourceRef } : {}),
    })),
    metadataConfidence,
  }
}

function issue(
  issues: VerificationIssue[],
  code: VerificationIssueCode,
  severity: VerificationIssue['severity'],
  message: string,
  location: Pick<VerificationIssue, 'sectionIndex' | 'itemIndex' | 'itemId'> = {},
): void {
  issues.push({ code, severity, message, ...location })
}

export function verifyBoqLocally(
  boq: Pick<Boq, 'vendor' | 'project' | 'workType' | 'date' | 'sections' | 'grandTotal' | 'sourceTotal'>,
): VerificationResult {
  const issues: VerificationIssue[] = []
  const candidate: Record<string, unknown> = isRecord(boq) ? boq : {}

  for (const field of ['vendor', 'project', 'date'] as const) {
    if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') {
      issue(issues, 'metadata_missing', 'blocking', `${field} is required`)
    }
  }
  if (!WORK_TYPES.includes(candidate.workType as WorkType) || candidate.workType === 'Unclassified') {
    issue(issues, 'metadata_missing', 'blocking', 'workType must be classified before approval')
  }

  let persistedGrandTotal: number | undefined
  if (typeof candidate.grandTotal !== 'number' || !Number.isFinite(candidate.grandTotal)) {
    issue(issues, 'invalid_number', 'blocking', 'grandTotal must be a finite number')
  } else if (candidate.grandTotal < 0) {
    issue(issues, 'invalid_number', 'blocking', 'grandTotal cannot be negative')
  } else {
    persistedGrandTotal = candidate.grandTotal
  }

  let itemTotalSum = 0
  let itemCount = 0
  let allItemTotalsValid = true
  const sections = Array.isArray(candidate.sections) ? candidate.sections : []
  if (!Array.isArray(candidate.sections)) {
    issue(issues, 'invalid_number', 'blocking', 'sections must contain valid line items')
    allItemTotalsValid = false
  }

  sections.forEach((section, sectionIndex) => {
    const sectionRecord = isRecord(section) ? section : {}
    const items = Array.isArray(sectionRecord.items) ? sectionRecord.items : []
    if (!Array.isArray(sectionRecord.items)) {
      issue(issues, 'invalid_number', 'blocking', 'section items must be an array', { sectionIndex })
      allItemTotalsValid = false
    }

    items.forEach((item, itemIndex) => {
      itemCount += 1
      const row = isRecord(item) ? item : {}
      const location = {
        sectionIndex,
        itemIndex,
        ...(typeof row.id === 'string' ? { itemId: row.id } : {}),
      }
      if (typeof row.desc !== 'string' || row.desc.trim() === '') {
        issue(issues, 'metadata_missing', 'blocking', 'Line item description is required', location)
      }
      if (typeof row.unit !== 'string' || row.unit.trim() === '') {
        issue(issues, 'metadata_missing', 'blocking', 'Line item unit is required', location)
      }

      let arithmeticInputsValid = true
      for (const field of ['qty', 'rate', 'total'] as const) {
        const value = row[field]
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issue(issues, 'invalid_number', 'blocking', `${field} must be a finite number`, location)
          arithmeticInputsValid = false
          if (field === 'total') allItemTotalsValid = false
        } else if (value < 0) {
          issue(issues, 'invalid_number', 'blocking', `${field} cannot be negative`, location)
          arithmeticInputsValid = false
          if (field === 'total') allItemTotalsValid = false
        } else if ((field === 'qty' || field === 'rate') && value === 0) {
          issue(issues, 'invalid_number', 'warning', `${field} is suspiciously zero`, location)
        }
      }

      if (typeof row.total === 'number' && Number.isFinite(row.total) && row.total >= 0) {
        itemTotalSum += row.total
      }
      if (arithmeticInputsValid) {
        const expected = (row.qty as number) * (row.rate as number)
        if (Math.abs(expected - (row.total as number)) > TOLERANCE) {
          issue(issues, 'line_total_mismatch', 'blocking', 'Line total does not match quantity multiplied by rate', location)
        }
      }
    })
  })

  if (itemCount === 0) {
    issue(issues, 'items_missing', 'blocking', 'At least one BOQ line item is required')
  }
  if (
    persistedGrandTotal !== undefined
    && allItemTotalsValid
    && Math.abs(itemTotalSum - persistedGrandTotal) > TOLERANCE
  ) {
    issue(issues, 'grand_total_mismatch', 'blocking', 'Persisted grand total does not match normalized line-item totals')
  }

  if (candidate.sourceTotal !== undefined) {
    if (typeof candidate.sourceTotal !== 'number' || !Number.isFinite(candidate.sourceTotal)) {
      issue(issues, 'invalid_number', 'blocking', 'sourceTotal must be a finite number')
    } else if (candidate.sourceTotal < 0) {
      issue(issues, 'invalid_number', 'blocking', 'sourceTotal cannot be negative')
    } else if (allItemTotalsValid && Math.abs(itemTotalSum - candidate.sourceTotal) > TOLERANCE) {
      issue(issues, 'document_total_mismatch', 'blocking', 'Normalized item total does not match the source document total')
    }
  }

  return {
    issues,
    hasBlockingIssues: issues.some((verificationIssue) => verificationIssue.severity === 'blocking'),
  }
}
