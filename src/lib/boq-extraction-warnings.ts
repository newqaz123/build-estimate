import type { BoqExtractionWarning, BoqSourceRef } from './boq-schema'

/** Plain, actionable user-facing labels grouped by stable parser warning code.
 *  Unknown codes fall back to a neutral category that never echoes the raw
 *  internal code, while still surfacing the exact original message in details. */
const EXTRACTION_WARNING_LABELS: Readonly<Record<string, string>> = {
  unsupported_row: 'Incomplete pricing or description',
  unparsed_row: 'Row layout could not be read',
  unsupported_numeric_format: 'Unrecognized number format',
  invalid_numeric_format: 'Unrecognized number format',
  incomplete_component_evidence: 'Incomplete material/labour evidence',
  component_total_mismatch: 'Material/labour did not reconcile with the total',
  item_arithmetic_mismatch: 'Quantity × rate did not match the amount',
  unequal_multiline_counts: 'Compound cell could not be split evenly',
  numeric_overflow: 'Numeric value too large to represent',
  ambiguous_merged_cell: 'Merged cell could not be split unambiguously',
  ambiguous_total_adjustments: 'Document total adjustments were ambiguous',
  ambiguous_source_binding: 'Source row binding was ambiguous',
  unmatched_source_binding: 'Source row could not be matched',
  source_discount: 'Source discount not applied automatically',
  document_total_mismatch: 'Document total did not reconcile with line items',
  section_total_mismatch: 'Section total did not reconcile',
}

const UNKNOWN_CODE_LABEL = 'Other extraction note'

export interface ExtractionWarningDetail {
  message: string
  sourceRef?: BoqSourceRef
}

export interface ExtractionWarningGroup {
  code: string
  /** Plain actionable copy describing what this group of warnings means. */
  label: string
  /** Total number of warnings in this group (including duplicate messages). */
  count: number
  /** Exact original messages, deduplicated, with their source locations preserved. */
  details: ExtractionWarningDetail[]
}

export function extractionWarningLabel(code: string): string {
  return EXTRACTION_WARNING_LABELS[code] ?? UNKNOWN_CODE_LABEL
}

/** Compact, human-readable source location, or null when none was retained. */
export function extractionWarningSourceLabel(sourceRef?: BoqSourceRef): string | null {
  if (!sourceRef) return null
  return `p. ${sourceRef.page} · table ${sourceRef.table} · row ${sourceRef.row}`
}

function detailKey(detail: ExtractionWarningDetail): string {
  return `${detail.message}\u0000${extractionWarningSourceLabel(detail.sourceRef) ?? ''}`
}

/** Groups extraction warnings by stable code, deduplicates identical messages
 *  (same text + same source location), and counts total occurrences so the
 *  default UI stays concise while the exact original messages remain available
 *  for an expandable details section. Group order is stable: by descending
 *  count, then by first-seen order. */
export function groupExtractionWarnings(warnings: ReadonlyArray<BoqExtractionWarning>): ExtractionWarningGroup[] {
  if (warnings.length === 0) return []
  type Accumulator = { code: string; count: number; details: Map<string, ExtractionWarningDetail> }
  const order: string[] = []
  const groups = new Map<string, Accumulator>()
  for (const warning of warnings) {
    if (groups.has(warning.code)) continue
    groups.set(warning.code, { code: warning.code, count: 0, details: new Map() })
    order.push(warning.code)
  }
  for (const warning of warnings) {
    const group = groups.get(warning.code)!
    group.count += 1
    const detail: ExtractionWarningDetail = {
      message: warning.message,
      ...(warning.sourceRef ? { sourceRef: warning.sourceRef } : {}),
    }
    const key = detailKey(detail)
    if (!group.details.has(key)) group.details.set(key, detail)
  }
  return order
    .map((code) => {
      const group = groups.get(code)!
      return {
        code: group.code,
        label: extractionWarningLabel(group.code),
        count: group.count,
        details: [...group.details.values()],
      }
    })
    .sort((a, b) => b.count - a.count)
}

/** Total number of extraction-warning occurrences (the raw warning count).
 *  This is an occurrence count, not a row count — multiple warnings can
 *  originate from the same source row, so never equate it to a row count. */
export function extractionWarningCount(warnings: ReadonlyArray<BoqExtractionWarning>): number {
  return warnings.length
}

/** Warning sections. `document_information` covers commercial facts (such as
 *  a source discount) the operator should know about but does not need to fix;
 *  `needs_review` covers parser ambiguity, unsupported rows, and
 *  reconciliation failures. Codes outside the explicit information set —
 *  including every unknown code — fail safe into `needs_review`. */
export type ExtractionWarningSection = 'needs_review' | 'document_information'

const EXTRACTION_WARNING_INFORMATION_CODES: ReadonlySet<string> = new Set(['source_discount'])

const DEFAULT_LOCATION_SEGMENTS = 2

export function extractionWarningSection(code: string): ExtractionWarningSection {
  return EXTRACTION_WARNING_INFORMATION_CODES.has(code) ? 'document_information' : 'needs_review'
}

export interface ExtractionWarningSummary {
  /** Unique source rows flagged by review-required warnings (deduplicated by
   *  page:table:row across codes). Document-level warnings never count as rows. */
  affectedRowCount: number
  /** Occurrences of document-information warnings (notes, not rows). */
  documentInformationCount: number
  /** Raw warning occurrences, including duplicates. */
  rawOccurrenceCount: number
  needsReview: ExtractionWarningGroup[]
  documentInformation: ExtractionWarningGroup[]
}

/** Splits warnings into a concise task summary: unique affected rows that need
 *  review versus document information the operator merely needs to know.
 *  Every raw detail and occurrence is preserved for the technical view. */
export function summarizeExtractionWarnings(
  warnings: ReadonlyArray<BoqExtractionWarning>,
): ExtractionWarningSummary {
  const groups = groupExtractionWarnings(warnings)
  const needsReview = groups.filter((group) => extractionWarningSection(group.code) === 'needs_review')
  const documentInformation = groups.filter(
    (group) => extractionWarningSection(group.code) === 'document_information',
  )
  const affectedRows = new Set<string>()
  for (const warning of warnings) {
    if (extractionWarningSection(warning.code) !== 'needs_review') continue
    const sourceRef = warning.sourceRef
    if (!sourceRef) continue
    affectedRows.add(`${sourceRef.page}:${sourceRef.table}:${sourceRef.row}`)
  }
  return {
    affectedRowCount: affectedRows.size,
    documentInformationCount: documentInformation.reduce((total, group) => total + group.count, 0),
    rawOccurrenceCount: warnings.length,
    needsReview,
    documentInformation,
  }
}

interface LocationSegment {
  page: number
  table: number
  rows: number[]
}

function rowRanges(rows: ReadonlyArray<number>): string[] {
  const ranges: Array<{ start: number; end: number }> = []
  for (const row of rows) {
    const last = ranges[ranges.length - 1]
    if (last && row === last.end + 1) last.end = row
    else ranges.push({ start: row, end: row })
  }
  return ranges.map((range) => (range.end === range.start ? `${range.start}` : `${range.start}–${range.end}`))
}

function segmentLabel(segment: LocationSegment): string {
  const ranges = rowRanges(segment.rows)
  const location = `Page ${segment.page}${segment.table === 1 ? '' : `, table ${segment.table}`}`
  const rows =
    ranges.length === 1 && segment.rows.length === 1 ? `row ${ranges[0]}` : `rows ${ranges.join(', ')}`
  return `${location} · ${rows}`
}

/** Compresses sorted unique source refs into compact per-page/table labels
 *  with consecutive row ranges, e.g. "Page 2 · rows 3, 6–9, 11". The preview
 *  is bounded to whole segments (`maxSegments`, default 2); a displayed
 *  segment never drops interior rows, and `hiddenCount` reports how many
 *  unique rows were left out of the label. */
export function compactExtractionWarningLocations(
  refs: ReadonlyArray<BoqSourceRef>,
  maxSegments = DEFAULT_LOCATION_SEGMENTS,
): { label: string; hiddenCount: number } {
  if (refs.length === 0) return { label: '', hiddenCount: 0 }
  const unique = new Map<string, BoqSourceRef>()
  for (const ref of refs) unique.set(`${ref.page}:${ref.table}:${ref.row}`, ref)
  const sorted = [...unique.values()].sort(
    (a, b) => a.page - b.page || a.table - b.table || a.row - b.row,
  )
  const segments: LocationSegment[] = []
  for (const ref of sorted) {
    const last = segments[segments.length - 1]
    if (last && last.page === ref.page && last.table === ref.table) last.rows.push(ref.row)
    else segments.push({ page: ref.page, table: ref.table, rows: [ref.row] })
  }
  const visible = segments.slice(0, Math.max(0, maxSegments))
  const hidden = segments.slice(visible.length)
  return {
    label: visible.map(segmentLabel).join('; '),
    hiddenCount: hidden.reduce((total, segment) => total + segment.rows.length, 0),
  }
}
