import type {
  Boq,
  BoqItem,
  BoqMetadataConfidence,
  WorkType,
} from './boq-schema'
import { deriveSourceCostAllocation } from './boq-cost-allocation'
import { calculateBoqTotals } from './boq-pricing'
import {
  type BoqSourceRowV3,
  type DoclingMetadata,
  type DoclingReconciliationV3,
  type DoclingResult,
  type DoclingResultV2,
  type DoclingResultV3,
  type DoclingSectionV3,
  type DoclingWarningV3,
} from './boq-extraction-schema'
export { parseDoclingResult } from './boq-extraction-schema'
export type {
  DoclingItemV2 as DoclingItem,
  DoclingMetadata,
  DoclingMetadataField,
  DoclingRawTable,
  DoclingResult,
  DoclingResultV2,
  DoclingResultV3,
  DoclingSectionV2 as DoclingSection,
} from './boq-extraction-schema'

const WORK_TYPES: readonly WorkType[] = ['Structural', 'MEP', 'Finishing', 'Unclassified']
const TOLERANCE = 0.01

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

export function buildDraftBoq(
  id: string,
  sourcePath: string,
  parsed: DoclingResultV2,
): Omit<Boq, 'createdAt' | 'updatedAt'> {
  const sections = parsed.sections.map((section) => ({
    header: section.header,
    items: section.items.map((item): BoqItem => {
      const draftItem: BoqItem = {
        id: item.id,
        desc: item.desc,
        pricingRole: 'standard',
        unit: item.unit,
        qty: item.qty,
        rate: item.rate,
        total: item.total,
        type: item.type,
        costComponent: item.costComponent,
        sourceRef: item.sourceRef,
        ...(item.sourceCosts ? { sourceCosts: item.sourceCosts } : {}),
        stdStatus: 'unmatched',
      }
      const costAllocation = deriveSourceCostAllocation(draftItem)
      return costAllocation ? { ...draftItem, costAllocation } : draftItem
    }),
  }))
  const { totalItems, grandTotal } = calculateBoqTotals(sections)
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
    totalItems,
    grandTotal,
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

export interface BoqExtractionRunSeed {
  id: string
  boqId: string
  contractVersion: 3
  sourceFileName: string
  sourceStoragePath: string
  pageCount: number
  documentText: string
  sourceRows: BoqSourceRowV3[]
  sections: DoclingSectionV3[]
  metadata: DoclingMetadata
  warnings: DoclingWarningV3[]
  reconciliation: DoclingReconciliationV3
  sourceTotal?: number | null
  totalItems: number
}

export interface DraftImport {
  boq: Omit<Boq, 'createdAt' | 'updatedAt'>
  run: BoqExtractionRunSeed | null
}

function metadataConfidence(parsed: Pick<DoclingResult, 'metadata'>): BoqMetadataConfidence {
  return {
    vendor: parsed.metadata.vendor.confidence,
    project: parsed.metadata.project.confidence,
    date: parsed.metadata.date.confidence,
    workType: parsed.metadata.workType.confidence,
  }
}

function canonicalWarnings(warnings: DoclingWarningV3[]): NonNullable<Boq['extractionWarnings']> {
  return warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    ...(warning.sourceRef ? { sourceRef: warning.sourceRef } : {}),
  }))
}

function buildV3Draft(
  id: string,
  sourcePath: string,
  parsed: DoclingResultV3,
  runId: string,
): DraftImport {
  if (runId.trim() === '') throw new TypeError('runId must be a non-empty string')
  const sourceRows = new Map(parsed.sourceRows.map((row) => [row.id, row]))
  const sections = parsed.sections.map((section) => ({
    header: section.header,
    items: section.items.map((item): BoqItem => {
      const firstRow = sourceRows.get(item.sourceRowIds[0])
      const sourceRef = firstRow
        ? { page: firstRow.page, table: firstRow.table, row: firstRow.row }
        : undefined
      const extractionWarnings = item.sourceRowIds.flatMap((rowId) =>
        sourceRows.get(rowId)?.warnings ?? [])
      const common = {
        id: item.id,
        desc: item.desc,
        sourceRowId: item.sourceRowIds[0],
        sourceRowIds: [...item.sourceRowIds],
        entryOrigin: item.entryOrigin,
        optional: item.optional,
        excludedFromTotal: item.excludedFromTotal,
        ...(item.exclusionReason ? { exclusionReason: item.exclusionReason } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        ...(extractionWarnings.length > 0
          ? { extractionWarnings: canonicalWarnings(extractionWarnings) }
          : {}),
      }
      if (item.pricingRole === 'bundle_child') {
        return {
          ...common,
          pricingRole: 'bundle_child',
          parentBundleId: item.parentBundleId,
          stdStatus: 'pending',
        }
      }
      const sourceCosts = item.sourceCosts
        ? {
            material: { ...item.sourceCosts.material, present: true },
            labour: { ...item.sourceCosts.labour, present: true },
          }
        : undefined
      const draftItem: BoqItem = {
        ...common,
        pricingRole: item.pricingRole,
        unit: item.unit,
        qty: item.qty,
        rate: item.rate,
        total: item.total,
        type: item.costComponent === 'lump_sum' ? 'lump_sum' : 'unit',
        costComponent: item.costComponent,
        ...(sourceCosts ? { sourceCosts } : {}),
        stdStatus: item.excludedFromTotal ? 'excluded' : 'unmatched',
      }
      const allocation = deriveSourceCostAllocation(draftItem)
      return allocation ? { ...draftItem, costAllocation: allocation } : draftItem
    }),
  }))
  const totals = calculateBoqTotals(sections)
  const boq: Omit<Boq, 'createdAt' | 'updatedAt'> = {
    id,
    project: parsed.metadata.project.value,
    vendor: parsed.metadata.vendor.value,
    workType: parsed.metadata.workType.value,
    date: parsed.metadata.date.value,
    ...totals,
    status: 'draft',
    stdStatus: 'none',
    sections,
    sourceFileName: parsed.documentName,
    sourceStoragePath: sourcePath,
    sourcePageCount: parsed.pageCount,
    ...(typeof parsed.sourceTotal === 'number' ? { sourceTotal: parsed.sourceTotal } : {}),
    activeExtractionRunId: runId,
    extractionWarnings: canonicalWarnings(parsed.warnings),
    metadataConfidence: metadataConfidence(parsed),
  }
  const run: BoqExtractionRunSeed = structuredClone({
    id: runId,
    boqId: id,
    contractVersion: 3,
    sourceFileName: parsed.documentName,
    sourceStoragePath: sourcePath,
    pageCount: parsed.pageCount,
    documentText: parsed.documentText,
    sourceRows: parsed.sourceRows,
    sections: parsed.sections,
    metadata: parsed.metadata,
    warnings: parsed.warnings,
    reconciliation: parsed.reconciliation,
    ...(parsed.sourceTotal === undefined ? {} : { sourceTotal: parsed.sourceTotal }),
    totalItems: parsed.totalItems,
  })
  return { boq, run }
}

/**
 * Pure import adapter. Run identity is supplied by the caller so validation and
 * draft construction never depend on time or randomness. Task 6 owns ID
 * generation and staged persistence.
 */
export function buildDraftImport(
  id: string,
  sourcePath: string,
  parsed: DoclingResult,
  runId: string,
): DraftImport {
  return parsed.contractVersion === 2
    ? { boq: buildDraftBoq(id, sourcePath, parsed), run: null }
    : buildV3Draft(id, sourcePath, parsed, runId)
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
      const row = isRecord(item) ? item : {}
      if (row.pricingRole === 'bundle_child') return
      itemCount += 1
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

      if (row.excludedFromTotal !== true && typeof row.total === 'number' && Number.isFinite(row.total) && row.total >= 0) {
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
