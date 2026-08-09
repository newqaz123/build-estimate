import type { BoqSourceRef } from './boq-schema'
import type { RowRole } from './actionable-review-types'
import type { BoqExtractionRun } from './boq-extraction-run'
import type {
  BoqSourceRowV3,
  DoclingRawCellV3,
} from './boq-extraction-schema'
import {
  addDecimal,
  equalAtMinorUnit,
  parseDecimalString,
  type DecimalString,
} from './decimal-string'

/**
 * Evidence-only deterministic triage findings.
 * Never carries authoritative BOQ pricing — role + provenance + reason codes only.
 */
export interface RowRoleFinding {
  sourceRowId: string
  role: RowRole
  reasonCodes: string[]
  deterministic: boolean
  sourceRef: BoqSourceRef
}

const NOISE_CELL = /^(?:[-–—_]|n\/?a)?$/i

/**
 * Mirror production currency-aware amount cells from source mapping:
 * optional leading/trailing currency code or symbol, commas, decimals.
 * Used only for amount-bearing detection / exact arithmetic evidence.
 */
const STRICT_AMOUNT = /^(?:([A-Z]{3}|[$£¥฿€])\s*)?(\()?((?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)(\))?(?:\s*([A-Z]{3}))?$/

const AMOUNT_IN_WORDS = /\b(?:baht|amount\s+in\s+words)\b[\s\S]*\bonly\b/i
/** Whole-label subtotal summaries only — not "Sub-total valve works". */
const SUBTOTAL_LABEL = /^(?:sub[\s-]*totals?)\s*:?\s*$/i
/** Whole-label grand totals only. */
const GRAND_TOTAL_LABEL = /^(?:grand[\s-]+totals?)\s*:?\s*$/i
/** Bare summary totals only — not descriptive phrases like "Total station survey". */
const TIGHT_TOTAL_LABEL = /^(?:totals?)\s*:?\s*$/i
/**
 * Whole-label tax summaries only (optional rate / Add VAT).
 * Not descriptive phrases like "VAT inclusive works" or "GST registration fee".
 */
const TAX_LABEL = /^(?:(?:add\s+)?vat(?:\s*\d+(?:\.\d+)?\s*%)?|gst(?:\s*\d+(?:\.\d+)?\s*%)?|wht(?:\s*\d+(?:\.\d+)?\s*%)?|sales\s+tax|output\s+tax)\s*:?\s*$/i
const NOTE_LABEL = /^(?:notes?|remarks?)\b/i
const CONTINUATION_CUE = /^(?:including|incl\.?|complete\s+with|with|and|&)\b/i

const HEADER_VOCAB = new Set([
  'description',
  'description of works',
  'particulars',
  'item description',
  'work description',
  'unit',
  'uom',
  'unit of measure',
  'qty',
  'q ty',
  'quantity',
  'quant',
  'rate',
  'unit rate',
  'price',
  'unit price',
  'amount',
  'total',
  'total amount',
  'extended amount',
  'value',
  'code',
  'item',
  'item no',
  'item number',
  'ref',
  'reference',
  'no',
])

interface ClassifiedCandidate {
  role: RowRole
  reasonCodes: string[]
}

interface RowEvidence {
  row: BoqSourceRowV3
  sourceRef: BoqSourceRef
  anchorCells: DoclingRawCellV3[]
  normalizedCellTexts: string[]
  joinedText: string
  amountBearing: boolean
  /** Exact decimal amount cells only; never emitted on findings. */
  standaloneAmounts: DecimalString[]
  warningCodes: string[]
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Parse a standalone amount cell using currency-aware production semantics.
 * Returns canonical DecimalString for exact arithmetic; null if not an amount cell.
 */
function parseAmountCell(text: string): DecimalString | null {
  const match = STRICT_AMOUNT.exec(text.trim())
  if (!match) return null
  // Reject dual currency markers and parenthetical negatives (same as source mapping).
  if ((match[1] !== undefined && match[5] !== undefined) || Boolean(match[2]) !== Boolean(match[4])) {
    return null
  }
  if (match[2]) return null
  try {
    return parseDecimalString(match[3]!.replaceAll(',', ''))
  } catch {
    return null
  }
}

function isAmountCell(text: string): boolean {
  return parseAmountCell(text) !== null
}

function isNoiseText(text: string): boolean {
  return NOISE_CELL.test(text.trim())
}

function anchorCellsOf(row: BoqSourceRowV3): DoclingRawCellV3[] {
  return row.rawCells.filter((cell) => !cell.carried)
}

function collectWarnings(
  row: BoqSourceRowV3,
  run: BoqExtractionRun,
): string[] {
  const codes = new Set<string>()
  for (const warning of row.warnings) {
    if (warning.code.trim()) codes.add(warning.code)
  }
  for (const warning of run.warnings) {
    if (!warning.sourceRef) continue
    if (
      warning.sourceRef.page === row.page
      && warning.sourceRef.table === row.table
      && warning.sourceRef.row === row.row
      && warning.code.trim()
    ) {
      codes.add(warning.code)
    }
  }
  return [...codes]
}

function buildEvidence(
  row: BoqSourceRowV3,
  run: BoqExtractionRun,
): RowEvidence {
  const anchorCells = anchorCellsOf(row)
  const normalizedCellTexts = anchorCells
    .map((cell) => cell.rawText.trim())
    .filter((text) => text.length > 0)
  const standaloneAmounts: DecimalString[] = []
  for (const text of normalizedCellTexts) {
    const amount = parseAmountCell(text)
    if (amount !== null) standaloneAmounts.push(amount)
  }
  return {
    row,
    sourceRef: { page: row.page, table: row.table, row: row.row },
    anchorCells,
    normalizedCellTexts,
    joinedText: normalizedCellTexts.join(' | '),
    amountBearing: standaloneAmounts.length > 0,
    standaloneAmounts,
    warningCodes: collectWarnings(row, run),
  }
}

function isBlankOrNoise(evidence: RowEvidence): boolean {
  if (evidence.amountBearing) return false
  if (evidence.normalizedCellTexts.length === 0) return true
  return evidence.normalizedCellTexts.every((text) => isNoiseText(text))
}

function headerVocabHitCount(texts: readonly string[]): number {
  let hits = 0
  for (const text of texts) {
    if (HEADER_VOCAB.has(normalizeLabel(text))) hits += 1
  }
  return hits
}

function looksLikeHeaderBand(evidence: RowEvidence): boolean {
  if (evidence.amountBearing) return false
  if (evidence.normalizedCellTexts.length === 0) return false
  const hits = headerVocabHitCount(evidence.normalizedCellTexts)
  if (hits >= 2) return true
  if (
    evidence.normalizedCellTexts.length >= 3
    && hits >= Math.ceil(evidence.normalizedCellTexts.length * 0.6)
  ) {
    return true
  }
  return false
}

function matchesRepeatedHeaders(
  evidence: RowEvidence,
  tableRows: readonly RowEvidence[],
): boolean {
  if (evidence.amountBearing) return false
  if (evidence.normalizedCellTexts.length < 2) return false

  const ownLabels = evidence.normalizedCellTexts.map(normalizeLabel).filter(Boolean)
  if (ownLabels.length < 2) return false

  const headerTemplate = evidence.row.headers
    .map(normalizeLabel)
    .filter(Boolean)
  if (headerTemplate.length >= 2) {
    const overlap = ownLabels.filter((label) => headerTemplate.includes(label)).length
    if (overlap >= Math.min(3, headerTemplate.length) && overlap >= ownLabels.length - 1) {
      return true
    }
  }

  for (const other of tableRows) {
    if (other.row.id === evidence.row.id) continue
    if (other.row.classification !== 'header' && !looksLikeHeaderBand(other)) continue
    const otherLabels = other.normalizedCellTexts.map(normalizeLabel).filter(Boolean)
    if (otherLabels.length < 2) continue
    if (
      ownLabels.length === otherLabels.length
      && ownLabels.every((label, index) => label === otherLabels[index])
    ) {
      return true
    }
  }
  return false
}

function hasColumnHeaderFlags(evidence: RowEvidence): boolean {
  const anchors = evidence.anchorCells
  if (anchors.length === 0) return false
  const flagged = anchors.filter((cell) => cell.columnHeader).length
  return flagged > 0 && flagged >= Math.ceil(anchors.length / 2)
}

function hasRowSectionFlags(evidence: RowEvidence): boolean {
  return evidence.anchorCells.some((cell) => cell.rowSection)
}

function primaryLabel(evidence: RowEvidence): string {
  for (const text of evidence.normalizedCellTexts) {
    if (!isAmountCell(text) && !isNoiseText(text)) {
      return text
    }
  }
  return evidence.joinedText || evidence.row.rawText
}

function isTightTotalLabelText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (GRAND_TOTAL_LABEL.test(trimmed)) return true
  if (TIGHT_TOTAL_LABEL.test(trimmed)) return true
  // Allow "Total:" with optional trailing whitespace already covered; reject longer phrases.
  const normalized = normalizeLabel(trimmed)
  return normalized === 'total' || normalized === 'totals' || normalized === 'grand total' || normalized === 'grand totals'
}

function isTaxSummaryLabel(text: string): boolean {
  return TAX_LABEL.test(text.trim())
}

function isSubtotalSummaryLabel(text: string): boolean {
  return SUBTOTAL_LABEL.test(text.trim())
}

/** True when every non-amount text cell is a tight summary label of the given kind. */
function hasTightSummaryLabelCells(
  evidence: RowEvidence,
  isSummaryLabel: (text: string) => boolean,
): boolean {
  const nonAmount = evidence.normalizedCellTexts.filter(
    (text) => !isAmountCell(text) && !isNoiseText(text),
  )
  if (nonAmount.length === 0) return false
  return nonAmount.every((text) => isSummaryLabel(text))
}

function clearPricedItemShape(evidence: RowEvidence): boolean {
  if (!evidence.amountBearing) return false
  if (evidence.row.classification === 'option') return false

  const headers = evidence.row.headers.map(normalizeLabel)
  const unitIdx = headers.findIndex((header) => HEADER_VOCAB.has(header) && (
    header === 'unit'
    || header === 'uom'
    || header.includes('unit')
  ))
  const qtyIdx = headers.findIndex((header) => (
    header === 'qty'
    || header === 'q ty'
    || header === 'quantity'
    || header === 'quant'
  ))
  const rateIdx = headers.findIndex((header) => (
    header === 'rate'
    || header === 'unit rate'
    || header === 'price'
    || header === 'unit price'
  ))
  const amountIdx = headers.findIndex((header) => (
    header === 'amount'
    || header === 'total'
    || header === 'total amount'
    || header === 'extended amount'
    || header === 'value'
  ))

  const cellByColumn = new Map<number, string>()
  for (const cell of evidence.anchorCells) {
    const text = cell.rawText.trim()
    if (!text) continue
    cellByColumn.set(cell.column, text)
    cellByColumn.set(cell.startColumnOffset, text)
  }

  const textAt = (index: number): string => {
    if (index < 0) return ''
    return cellByColumn.get(index)?.trim() ?? ''
  }

  const description = textAt(0)
    || evidence.normalizedCellTexts.find((text) => !isAmountCell(text))
    || ''
  if (!description || isNoiseText(description)) return false

  const unitText = unitIdx >= 0 ? textAt(unitIdx) : ''
  const qtyText = qtyIdx >= 0 ? textAt(qtyIdx) : ''
  const rateText = rateIdx >= 0 ? textAt(rateIdx) : ''
  const amountText = amountIdx >= 0 ? textAt(amountIdx) : ''

  const hasUnit = unitText.length > 0 && !isAmountCell(unitText)
  const hasQty = qtyText.length > 0 && isAmountCell(qtyText)
  const hasRate = rateText.length > 0 && isAmountCell(rateText)
  const hasAmount = amountText.length > 0 && isAmountCell(amountText)

  // Classic BOQ shape: description + unit + qty + (rate or amount)
  if (hasUnit && hasQty && (hasRate || hasAmount)) return true

  // Fallback: description plus at least two numeric pricing cells and a non-numeric unit-like token.
  const nonNumeric = evidence.normalizedCellTexts.filter((text) => !isAmountCell(text) && !isNoiseText(text))
  if (nonNumeric.length >= 2 && evidence.standaloneAmounts.length >= 2) {
    const maybeUnit = nonNumeric.some((text) => text.length <= 8 && !HEADER_VOCAB.has(normalizeLabel(text)))
    if (maybeUnit) return true
  }

  return false
}

function nearbyItemAmountSum(
  evidence: RowEvidence,
  tableRows: readonly RowEvidence[],
): DecimalString | null {
  const prior = tableRows
    .filter((candidate) => (
      candidate.row.id !== evidence.row.id
      && candidate.row.row < evidence.row.row
      && candidate.row.classification === 'item'
      && clearPricedItemShape(candidate)
    ))
    .sort((left, right) => left.row.row - right.row.row)

  if (prior.length === 0) return null

  let sum: DecimalString | null = null
  for (const candidate of prior) {
    const amount = candidate.standaloneAmounts[candidate.standaloneAmounts.length - 1]
    if (amount === undefined) continue
    sum = sum === null ? amount : addDecimal(sum, amount)
  }
  return sum
}

function classifyOne(
  evidence: RowEvidence,
  tableRows: readonly RowEvidence[],
): ClassifiedCandidate {
  const reasons: string[] = []
  const label = primaryLabel(evidence)
  const normalizedJoined = evidence.joinedText
  const classification = evidence.row.classification
  const pricedShape = clearPricedItemShape(evidence)

  // 1. Blank / noise (never amount-bearing).
  if (isBlankOrNoise(evidence)) {
    return {
      role: 'blank_or_noise',
      reasonCodes: ['blank_or_noise_evidence'],
    }
  }

  // 2. Column headers (parser role, flags, vocabulary band, repeated labels).
  if (classification === 'header') {
    reasons.push('parser_classification_header')
  }
  if (hasColumnHeaderFlags(evidence)) {
    reasons.push('cell_column_header_flags')
  }
  if (looksLikeHeaderBand(evidence)) {
    reasons.push('header_vocabulary_band')
  }
  if (matchesRepeatedHeaders(evidence, tableRows)) {
    reasons.push('repeated_normalized_header_labels')
  }
  if (reasons.some((code) => (
    code === 'parser_classification_header'
    || code === 'cell_column_header_flags'
    || code === 'header_vocabulary_band'
    || code === 'repeated_normalized_header_labels'
  )) && !evidence.amountBearing) {
    return { role: 'column_header', reasonCodes: dedupe(reasons) }
  }

  // 3. Amount in words (before note, even if parser said note).
  if (AMOUNT_IN_WORDS.test(normalizedJoined) || AMOUNT_IN_WORDS.test(evidence.row.rawText)) {
    return {
      role: 'amount_in_words',
      reasonCodes: ['amount_in_words_pattern'],
    }
  }

  // 4. Tax / VAT summary — whole-label only; clear priced-item shapes never dismissed.
  const hasTaxSummaryLabel = isTaxSummaryLabel(label)
    || hasTightSummaryLabelCells(evidence, isTaxSummaryLabel)
  if (!pricedShape && hasTaxSummaryLabel) {
    const taxReasons = ['tax_label_pattern']
    if (classification === 'total') taxReasons.push('parser_classification_total')
    return { role: 'tax', reasonCodes: taxReasons }
  }

  // 5. Subtotal — whole-label only; clear priced-item shapes never dismissed.
  const hasSubtotalLabel = isSubtotalSummaryLabel(label)
    || hasTightSummaryLabelCells(evidence, isSubtotalSummaryLabel)
  if (!pricedShape && hasSubtotalLabel) {
    const subtotalReasons = ['subtotal_label_pattern']
    if (classification === 'total') subtotalReasons.push('parser_classification_total')
    if (evidence.amountBearing) {
      const expected = nearbyItemAmountSum(evidence, tableRows)
      const actual = evidence.standaloneAmounts[evidence.standaloneAmounts.length - 1]
      if (expected !== null && actual !== undefined && equalAtMinorUnit(expected, actual, 2)) {
        subtotalReasons.push('arithmetic_nearby_item_sum')
      }
    }
    return { role: 'subtotal', reasonCodes: subtotalReasons }
  }

  // 6. Grand total / tight bare total summaries.
  // Clear priced-item shapes (e.g. "Total station survey") never lose to bare ^total text.
  // Parser classification `total` alone is insufficient without a tight total label.
  const hasGrandTotalLabel = GRAND_TOTAL_LABEL.test(label) || GRAND_TOTAL_LABEL.test(normalizedJoined)
  const hasTightTotalLabel = isTightTotalLabelText(label)
    || (
      evidence.normalizedCellTexts.length > 0
      && evidence.normalizedCellTexts
        .filter((text) => !isAmountCell(text) && !isNoiseText(text))
        .every((text) => isTightTotalLabelText(text))
      && evidence.normalizedCellTexts.some((text) => isTightTotalLabelText(text))
    )

  if (!pricedShape && (hasGrandTotalLabel || hasTightTotalLabel)) {
    const totalReasons: string[] = []
    if (hasGrandTotalLabel) {
      totalReasons.push('grand_total_label_pattern')
    } else {
      totalReasons.push('total_label_pattern')
    }
    if (classification === 'total') totalReasons.push('parser_classification_total')
    return { role: 'total', reasonCodes: dedupe(totalReasons) }
  }

  // 7. Section headers (structural; amount-bearing sections stay uncertain).
  if (!evidence.amountBearing) {
    if (classification === 'section' || hasRowSectionFlags(evidence)) {
      const sectionReasons: string[] = []
      if (classification === 'section') sectionReasons.push('parser_classification_section')
      if (hasRowSectionFlags(evidence)) sectionReasons.push('cell_row_section_flags')
      return { role: 'section_header', reasonCodes: sectionReasons }
    }
  }

  // 8. Notes — never dismiss amount-bearing rows as notes.
  if (!evidence.amountBearing) {
    if (classification === 'note' || NOTE_LABEL.test(label) || NOTE_LABEL.test(normalizedJoined)) {
      const noteReasons: string[] = []
      if (classification === 'note') noteReasons.push('parser_classification_note')
      if (NOTE_LABEL.test(label) || NOTE_LABEL.test(normalizedJoined)) {
        noteReasons.push('note_label_pattern')
      }
      return { role: 'note', reasonCodes: noteReasons.length > 0 ? noteReasons : ['note_label_pattern'] }
    }
  }

  // 9. Continuations — description tails without amounts.
  if (!evidence.amountBearing) {
    if (
      classification === 'continuation'
      || (
        evidence.normalizedCellTexts.length <= 2
        && CONTINUATION_CUE.test(label)
        && tableRows.some((candidate) => (
          candidate.row.row === evidence.row.row - 1
          && (
            candidate.row.classification === 'item'
            || clearPricedItemShape(candidate)
          )
        ))
      )
    ) {
      const continuationReasons: string[] = []
      if (classification === 'continuation') {
        continuationReasons.push('parser_classification_continuation')
      } else {
        continuationReasons.push('continuation_structure')
      }
      return { role: 'continuation', reasonCodes: continuationReasons }
    }
  }

  // 10. Clear priced item shape (wins over loose total-like description text).
  if (pricedShape) {
    const pricedReasons = ['clear_priced_item_shape']
    if (classification === 'item') pricedReasons.push('parser_classification_item')
    return { role: 'priced_item', reasonCodes: pricedReasons }
  }

  // 11. Conservative fallback — amount-bearing unproven rows stay uncertain.
  // Reason codes cite only evidence actually present (no fabricated total labels).
  const uncertainReasons: string[] = []
  if (evidence.amountBearing) {
    uncertainReasons.push('amount_bearing_unproven')
  } else {
    uncertainReasons.push('insufficient_structural_evidence')
  }
  if (classification === 'unknown') {
    uncertainReasons.push('parser_classification_unknown')
  }
  if (evidence.warningCodes.some((code) => /ambiguous|unsupported|incomplete/i.test(code))) {
    uncertainReasons.push('advisory_warning_codes')
  }
  return { role: 'uncertain', reasonCodes: dedupe(uncertainReasons) }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Classify every immutable source row into a conservative role finding.
 *
 * Uses parser classifications, cell flags, repeated normalized header labels,
 * arithmetic relationship to nearby items, and warning codes as evidence only.
 * Does not convert raw text/classifications into authoritative BOQ pricing.
 */
export function classifySourceRows(input: {
  run: BoqExtractionRun
  sourceRows: readonly BoqSourceRowV3[]
}): RowRoleFinding[] {
  const evidences = input.sourceRows.map((row) => buildEvidence(row, input.run))

  const byTable = new Map<string, RowEvidence[]>()
  for (const evidence of evidences) {
    const key = `${evidence.row.page}:${evidence.row.table}`
    const bucket = byTable.get(key)
    if (bucket) bucket.push(evidence)
    else byTable.set(key, [evidence])
  }

  return evidences.map((evidence) => {
    const tableRows = byTable.get(`${evidence.row.page}:${evidence.row.table}`) ?? [evidence]
    const classified = classifyOne(evidence, tableRows)
    return {
      sourceRowId: evidence.row.id,
      role: classified.role,
      reasonCodes: classified.reasonCodes,
      deterministic: true,
      sourceRef: evidence.sourceRef,
    }
  })
}
