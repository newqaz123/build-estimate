import type { BoqSourceRef } from './boq-schema'
import type { RowRole } from './actionable-review-types'
import type { BoqExtractionRun } from './boq-extraction-run'
import type {
  BoqSourceRowV3,
  DoclingRawCellV3,
} from './boq-extraction-schema'

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

const STANDALONE_NUMBER = /^(?:\(?[-+]?\d[\d,]*(?:\.\d+)?\)?)$/
const NOISE_CELL = /^(?:[-–—_]|n\/?a)?$/i

const AMOUNT_IN_WORDS = /\b(?:baht|amount\s+in\s+words)\b[\s\S]*\bonly\b/i
const SUBTOTAL_LABEL = /\bsub[\s-]*totals?\b/i
const GRAND_TOTAL_LABEL = /\bgrand[\s-]+totals?\b/i
const TOTAL_LABEL = /^(?:total|totals)(?:\s|$|:)/i
const TAX_LABEL = /\b(?:vat|tax|gst|wht)\b|\badd\s+vat\b/i
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
  standaloneAmounts: number[]
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

function parseStandaloneNumber(text: string): number | null {
  const trimmed = text.trim()
  if (!STANDALONE_NUMBER.test(trimmed)) return null
  const negative = trimmed.startsWith('(') && trimmed.endsWith(')')
  const core = trimmed.replace(/[(),]/g, '')
  const parsed = Number(core)
  if (!Number.isFinite(parsed)) return null
  return negative ? -parsed : parsed
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
  const standaloneAmounts: number[] = []
  for (const text of normalizedCellTexts) {
    const amount = parseStandaloneNumber(text)
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
    if (parseStandaloneNumber(text) === null && !isNoiseText(text)) {
      return text
    }
  }
  return evidence.joinedText || evidence.row.rawText
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
    // Also map by start column offset for multi-col layouts.
    cellByColumn.set(cell.startColumnOffset, text)
  }

  const textAt = (index: number): string => {
    if (index < 0) return ''
    return cellByColumn.get(index)?.trim() ?? ''
  }

  const description = textAt(0) || evidence.normalizedCellTexts.find((text) => parseStandaloneNumber(text) === null) || ''
  if (!description || isNoiseText(description)) return false

  const unitText = unitIdx >= 0 ? textAt(unitIdx) : ''
  const qtyText = qtyIdx >= 0 ? textAt(qtyIdx) : ''
  const rateText = rateIdx >= 0 ? textAt(rateIdx) : ''
  const amountText = amountIdx >= 0 ? textAt(amountIdx) : ''

  const hasUnit = unitText.length > 0 && parseStandaloneNumber(unitText) === null
  const hasQty = qtyText.length > 0 && parseStandaloneNumber(qtyText) !== null
  const hasRate = rateText.length > 0 && parseStandaloneNumber(rateText) !== null
  const hasAmount = amountText.length > 0 && parseStandaloneNumber(amountText) !== null

  // Classic BOQ shape: description + unit + qty + (rate or amount)
  if (hasUnit && hasQty && (hasRate || hasAmount)) return true

  // Fallback: description plus at least two numeric pricing cells and a non-numeric unit-like token.
  const nonNumeric = evidence.normalizedCellTexts.filter((text) => parseStandaloneNumber(text) === null && !isNoiseText(text))
  const numeric = evidence.standaloneAmounts
  if (nonNumeric.length >= 2 && numeric.length >= 2) {
    const maybeUnit = nonNumeric.some((text) => text.length <= 8 && !HEADER_VOCAB.has(normalizeLabel(text)))
    if (maybeUnit) return true
  }

  return false
}

function nearbyItemAmountSum(
  evidence: RowEvidence,
  tableRows: readonly RowEvidence[],
): number | null {
  const prior = tableRows
    .filter((candidate) => (
      candidate.row.id !== evidence.row.id
      && candidate.row.row < evidence.row.row
      && candidate.row.classification === 'item'
      && clearPricedItemShape(candidate)
    ))
    .sort((left, right) => left.row.row - right.row.row)

  if (prior.length === 0) return null

  // Sum priced items above this row in the same table.
  let sum = 0
  let sawItem = false
  for (const candidate of prior) {
    const amount = candidate.standaloneAmounts[candidate.standaloneAmounts.length - 1]
    if (amount === undefined) continue
    sum += amount
    sawItem = true
  }
  return sawItem ? sum : null
}

function amountsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.05
}

function classifyOne(
  evidence: RowEvidence,
  tableRows: readonly RowEvidence[],
): ClassifiedCandidate {
  const reasons: string[] = []
  const label = primaryLabel(evidence)
  const normalizedJoined = evidence.joinedText
  const classification = evidence.row.classification

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

  // 4. Tax / VAT summary (amount-bearing allowed when label proves role).
  if (TAX_LABEL.test(label) || TAX_LABEL.test(normalizedJoined)) {
    const taxReasons = ['tax_label_pattern']
    if (classification === 'total') taxReasons.push('parser_classification_total')
    return { role: 'tax', reasonCodes: taxReasons }
  }

  // 5. Subtotal (label, optional arithmetic confirmation with nearby items).
  if (SUBTOTAL_LABEL.test(label) || SUBTOTAL_LABEL.test(normalizedJoined)) {
    const subtotalReasons = ['subtotal_label_pattern']
    if (classification === 'total') subtotalReasons.push('parser_classification_total')
    if (evidence.amountBearing) {
      const expected = nearbyItemAmountSum(evidence, tableRows)
      const actual = evidence.standaloneAmounts[evidence.standaloneAmounts.length - 1]
      if (expected !== null && actual !== undefined && amountsMatch(expected, actual)) {
        subtotalReasons.push('arithmetic_nearby_item_sum')
      }
    }
    return { role: 'subtotal', reasonCodes: subtotalReasons }
  }

  // 6. Grand total / total summaries.
  if (
    GRAND_TOTAL_LABEL.test(label)
    || GRAND_TOTAL_LABEL.test(normalizedJoined)
    || (
      (TOTAL_LABEL.test(label) || TOTAL_LABEL.test(normalizedJoined) || classification === 'total')
      && !SUBTOTAL_LABEL.test(label)
      && !TAX_LABEL.test(label)
    )
  ) {
    const totalReasons: string[] = []
    if (GRAND_TOTAL_LABEL.test(label) || GRAND_TOTAL_LABEL.test(normalizedJoined)) {
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

  // 10. Clear priced item shape.
  if (clearPricedItemShape(evidence)) {
    const pricedReasons = ['clear_priced_item_shape']
    if (classification === 'item') pricedReasons.push('parser_classification_item')
    return { role: 'priced_item', reasonCodes: pricedReasons }
  }

  // 11. Conservative fallback — amount-bearing unproven rows stay uncertain.
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
