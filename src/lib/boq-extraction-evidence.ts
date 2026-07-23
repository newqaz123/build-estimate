/**
 * Server-owned, ordered extraction evidence packet builder.
 *
 * Builds immutable candidate items from the extraction run's derived sections
 * and assembles an ordered evidence packet for AI review. All numeric
 * authority (qty, rate, total, unit, description) comes from immutable run
 * data — never from provider output. The AI may only reference candidate IDs
 * and decide whether to insert, replace, or remove; it may never author
 * priced values.
 */

import type { BoqExtractionRun } from './boq-extraction-run'
import type {
  BoqSourceRowV3,
  DoclingSourceCostsV3,
  DerivedPricedItemV3,
} from './boq-extraction-schema'
import type { BoqItem } from './boq-schema'

/** A priced item derived from the immutable extraction run, keyed by a stable
 *  server-generated ID. This is the sole numeric authority for AI proposals. */
export interface ExtractionCandidateItem {
  id: string
  sectionIndex: number
  sectionHeader: string
  /** Stable physical order of the candidate's first source row. */
  sourceOrder: number
  sourceRowIds: string[]
  sourceRefs: Array<{ page: number; table: number; row: number }>
  desc: string
  pricingRole: 'standard'
  parentBundleId: null
  unit: string
  qty: number
  rate: number
  total: number
  costComponent: string
  sourceCosts: DoclingSourceCostsV3 | null
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason: string | null
}

/** Ordered source-row display with full raw-cell geometry for the prompt packet. */
export interface EvidenceSourceRow {
  id: string
  /** True when the model may reference this row in a decision. False rows are context only. */
  reviewSelected: boolean
  page: number
  table: number
  row: number
  section: string | null
  headers: string[]
  rawText: string
  rawCells: BoqSourceRowV3['rawCells']
  classification: string
  confidence: number
  warnings: BoqSourceRowV3['warnings']
}

/** A candidate item projected into the provider-safe prompt shape. */
export interface PromptCandidateItem {
  id: string
  sourceRowIds: string[]
  sectionIndex: number
  sectionHeader: string
  sourceOrder: number
  desc: string
  pricingRole: 'standard'
  unit: string
  qty: number
  rate: number
  total: number
  costComponent: string
  sourceCosts: DoclingSourceCostsV3 | null
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason: string | null
}

/** A canonical BOQ item projected into the provider-safe prompt shape. */
export interface PromptTargetItem {
  id: string
  sourceRowIds: string[]
  desc: string
  pricingRole: string
  unit: string | null
  qty: number | null
  rate: number | null
  total: number | null
  costComponent: string | null
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason: string | null
}

/** The complete ordered evidence packet sent to the provider. */
export interface ExtractionEvidencePacket {
  extractionRunId: string
  allowedSourceRowIds: string[]
  sourceRows: EvidenceSourceRow[]
  candidateItems: PromptCandidateItem[]
  currentTargetItems: PromptTargetItem[]
  reconciliation: { itemTotal: number; sourceTotal: number | null; reconciled: boolean; difference: number }
}

function compareSourceRows(left: Pick<BoqSourceRowV3, 'page' | 'table' | 'row' | 'id'>, right: Pick<BoqSourceRowV3, 'page' | 'table' | 'row' | 'id'>): number {
  return left.page - right.page || left.table - right.table || left.row - right.row || left.id.localeCompare(right.id)
}

function sourceRefFromRows(rows: readonly BoqSourceRowV3[], ids: readonly string[]): Array<{ page: number; table: number; row: number }> {
  const known = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = known.get(id)
    return row ? [{ page: row.page, table: row.table, row: row.row }] : []
  })
}

function isActionableCandidate(item: DerivedPricedItemV3 | { pricingRole: string }): item is DerivedPricedItemV3 & { pricingRole: 'standard' } {
  return item.pricingRole === 'standard'
}

/** Build immutable candidate items from the extraction run's derived sections.
 *  Only standalone priced items become actionable candidates. Bundle parents
 *  require their immutable children to preserve structure, so both bundle
 *  parents and children remain evidence-only and must route to human review. */
export function buildExtractionCandidates(
  run: BoqExtractionRun,
  sourceRows: readonly BoqSourceRowV3[],
): Map<string, ExtractionCandidateItem> {
  const candidates = new Map<string, ExtractionCandidateItem>()
  const orderedRows = [...sourceRows].sort(compareSourceRows)
  const sourceOrder = new Map(orderedRows.map((row, index) => [row.id, index]))
  run.sections.forEach((section, sectionIndex) => {
    for (const item of section.items) {
      if (!isActionableCandidate(item)) continue
      if (typeof item.id !== 'string' || item.id === '') continue
      if (candidates.has(item.id)) throw new TypeError(`Duplicate extraction candidate item ID: ${item.id}`)
      candidates.set(item.id, {
        id: item.id,
        sectionIndex,
        sectionHeader: section.header,
        sourceOrder: Math.min(...item.sourceRowIds.map((id) => sourceOrder.get(id) ?? Number.MAX_SAFE_INTEGER)),
        sourceRowIds: [...item.sourceRowIds],
        sourceRefs: sourceRefFromRows(sourceRows, item.sourceRowIds),
        desc: item.desc,
        pricingRole: item.pricingRole,
        parentBundleId: null,
        unit: item.unit,
        qty: item.qty,
        rate: item.rate,
        total: item.total,
        costComponent: item.costComponent,
        sourceCosts: item.sourceCosts ? structuredClone(item.sourceCosts) : null,
        optional: item.optional,
        excludedFromTotal: item.excludedFromTotal,
        exclusionReason: item.exclusionReason ?? null,
      })
    }
  })
  return candidates
}

/** Convert a candidate item into the provider-safe prompt shape. */
export function toPromptCandidate(candidate: ExtractionCandidateItem): PromptCandidateItem {
  return {
    id: candidate.id,
    sourceRowIds: [...candidate.sourceRowIds],
    sectionIndex: candidate.sectionIndex,
    sectionHeader: candidate.sectionHeader,
    sourceOrder: candidate.sourceOrder,
    desc: candidate.desc,
    pricingRole: candidate.pricingRole,
    unit: candidate.unit,
    qty: candidate.qty,
    rate: candidate.rate,
    total: candidate.total,
    costComponent: candidate.costComponent,
    sourceCosts: candidate.sourceCosts,
    optional: candidate.optional,
    excludedFromTotal: candidate.excludedFromTotal,
    exclusionReason: candidate.exclusionReason,
  }
}

/** Convert a canonical BOQ item into the provider-safe prompt shape. */
export function toPromptTargetItem(item: BoqItem): PromptTargetItem {
  return {
    id: item.id ?? '',
    sourceRowIds: item.sourceRowIds ?? (item.sourceRowId ? [item.sourceRowId] : []),
    desc: item.desc,
    pricingRole: item.pricingRole ?? 'standard',
    unit: 'unit' in item ? item.unit : null,
    qty: 'qty' in item ? item.qty : null,
    rate: 'rate' in item ? item.rate : null,
    total: 'total' in item ? item.total : null,
    costComponent: 'costComponent' in item ? (item.costComponent ?? null) : null,
    optional: item.optional === true,
    excludedFromTotal: item.excludedFromTotal === true,
    exclusionReason: item.exclusionReason ?? null,
  }
}

/** Build the ordered evidence packet for AI review. Source rows are ordered by
 *  physical position (page, table, row). Candidates follow source-row order. */
export function candidateMatchesCanonicalItem(candidate: ExtractionCandidateItem, item: BoqItem): boolean {
  if (!('unit' in item) || !('qty' in item) || !('rate' in item) || !('total' in item)) return false
  const itemSources = item.sourceRowIds ?? (item.sourceRowId ? [item.sourceRowId] : [])
  const sameSources = itemSources.length === candidate.sourceRowIds.length
    && itemSources.every((id, index) => id === candidate.sourceRowIds[index])
  const sourceCosts = 'sourceCosts' in item && item.sourceCosts ? {
    material: { qty: item.sourceCosts.material.qty, unit: item.sourceCosts.material.unit, rate: item.sourceCosts.material.rate, total: item.sourceCosts.material.total },
    labour: { qty: item.sourceCosts.labour.qty, unit: item.sourceCosts.labour.unit, rate: item.sourceCosts.labour.rate, total: item.sourceCosts.labour.total },
  } : null
  return sameSources
    && item.desc === candidate.desc
    && (item.pricingRole ?? 'standard') === candidate.pricingRole
    && item.unit === candidate.unit
    && item.qty === candidate.qty
    && item.rate === candidate.rate
    && item.total === candidate.total
    && (item.costComponent ?? 'combined') === candidate.costComponent
    && (item.optional === true) === candidate.optional
    && (item.excludedFromTotal === true) === candidate.excludedFromTotal
    && (item.exclusionReason ?? null) === candidate.exclusionReason
    && JSON.stringify(sourceCosts) === JSON.stringify(candidate.sourceCosts)
}

/** Build the prompt packet. Selected rows are accompanied by immediate row
 * neighbours and structural rows from the same table. Context rows are never
 * valid decision IDs, but preserve headers, section boundaries and totals. */
export function buildExtractionEvidencePacket(input: {
  run: BoqExtractionRun
  sourceRows: readonly BoqSourceRowV3[]
  candidates: Map<string, ExtractionCandidateItem>
  boqSections: readonly { items: BoqItem[] }[]
  selectedSourceRowIds: Set<string>
}): ExtractionEvidencePacket {
  const orderedRows = [...input.sourceRows].sort(compareSourceRows)
  const selectedRows = orderedRows.filter((row) => input.selectedSourceRowIds.has(row.id))
  const contextIds = new Set(input.selectedSourceRowIds)
  const selectedTables = new Set(selectedRows.map((row) => `${row.page}:${row.table}`))
  orderedRows.forEach((row, index) => {
    if (!input.selectedSourceRowIds.has(row.id)) return
    const previous = orderedRows[index - 1]
    const next = orderedRows[index + 1]
    if (previous && previous.page === row.page && previous.table === row.table) contextIds.add(previous.id)
    if (next && next.page === row.page && next.table === row.table) contextIds.add(next.id)
  })
  // Include each selected row's complete table in physical order. Docling may
  // omit empty cells, so distant header, section, and summary rows can be
  // necessary to interpret sparse component columns safely.
  for (const row of orderedRows) {
    if (selectedTables.has(`${row.page}:${row.table}`)) contextIds.add(row.id)
  }
  const contextRows = orderedRows.filter((row) => contextIds.has(row.id))

  const candidateBySourceRow = new Map<string, ExtractionCandidateItem>()
  for (const candidate of input.candidates.values()) {
    for (const sourceRowId of candidate.sourceRowIds) {
      if (input.selectedSourceRowIds.has(sourceRowId)) {
        candidateBySourceRow.set(sourceRowId, candidate)
      }
    }
  }

  const promptCandidates: PromptCandidateItem[] = []
  const seenCandidateIds = new Set<string>()
  for (const row of selectedRows) {
    const candidate = candidateBySourceRow.get(row.id)
    if (candidate && !seenCandidateIds.has(candidate.id)) {
      promptCandidates.push(toPromptCandidate(candidate))
      seenCandidateIds.add(candidate.id)
    }
  }

  const targetItems: PromptTargetItem[] = []
  for (const section of input.boqSections) {
    for (const item of section.items) {
      const sourceRows = item.sourceRowIds ?? (item.sourceRowId ? [item.sourceRowId] : [])
      if (sourceRows.some((id) => input.selectedSourceRowIds.has(id))) {
        targetItems.push(toPromptTargetItem(item))
      }
    }
  }

  return {
    extractionRunId: input.run.id,
    allowedSourceRowIds: selectedRows.map((row) => row.id),
    sourceRows: contextRows.map((row) => ({
      id: row.id,
      reviewSelected: input.selectedSourceRowIds.has(row.id),
      page: row.page,
      table: row.table,
      row: row.row,
      section: row.section,
      headers: [...row.headers],
      rawText: row.rawText.slice(0, 4_000),
      rawCells: row.rawCells.map((cell) => ({
        ...cell,
        lines: cell.lines.slice(0, 10),
        rawText: cell.rawText.slice(0, 500),
      })),
      classification: row.classification,
      confidence: row.confidence,
      warnings: row.warnings,
    })),
    candidateItems: promptCandidates,
    currentTargetItems: targetItems,
    reconciliation: { ...input.run.reconciliation },
  }
}
