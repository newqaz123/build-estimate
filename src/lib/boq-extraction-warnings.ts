import type { BoqExtractionWarning, BoqSourceRef } from './boq-schema'

/** Plain, actionable user-facing labels grouped by stable parser warning code.
 *  Unknown codes fall back to a neutral category that never echoes the raw
 *  internal code, while still surfacing the exact original message in details. */
const EXTRACTION_WARNING_LABELS: Readonly<Record<string, string>> = {
  unsupported_row: 'Incomplete pricing or description',
  unparsed_row: 'Row layout could not be read',
  unsupported_numeric_format: 'Unrecognized number format',
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
