import type { PreflightPage, PreflightTextSource } from './boq-preflight-schema'

export const PREFLIGHT_HIGH_CONFIDENCE_THRESHOLD = 0.6

export interface PreflightPageInput {
  page: number
  embeddedText?: string
  ocrText?: string
  geometry: {
    tableCount: number
    numericTokenCount: number
  }
}

const THAI_BOQ_TERMS = ['รายการ', 'จำนวน', 'หน่วย', 'วัสดุ', 'ค่าแรง', 'รวม']
const ENGLISH_STRUCTURE_TERMS = ['description', 'quantity']
const ENGLISH_COST_TERMS = ['material', 'labour', 'labor', 'rate', 'amount', 'total']
const QUANTITY_TERMS = ['quantity', 'qty', 'จำนวน']
const RATE_TERMS = ['rate', 'ราคา']
const AMOUNT_TERMS = ['amount', 'รวม', 'total']

function normalizedText(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

function includesTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text)
}

function countTerms(text: string, terms: readonly string[]): number {
  return terms.filter((term) => includesTerm(text, term)).length
}

function hasTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => includesTerm(text, term))
}

function textSourceFor(page: PreflightPageInput): { text: string; source: PreflightTextSource } {
  if (typeof page.embeddedText === 'string' && page.embeddedText.trim()) {
    return { text: normalizedText(page.embeddedText), source: 'embedded' }
  }
  if (typeof page.ocrText === 'string' && page.ocrText.trim()) {
    return { text: normalizedText(page.ocrText), source: 'ocr' }
  }
  return { text: '', source: 'unavailable' }
}

export function analyzePreflightPages(pages: readonly PreflightPageInput[]): PreflightPage[] {
  return pages.map((input) => {
    const { text, source } = textSourceFor(input)
    const reasons: string[] = []
    let score = 0

    const thaiTerms = countTerms(text, THAI_BOQ_TERMS)
    const hasEnglishStructure = hasTerm(text, ENGLISH_STRUCTURE_TERMS)
    const hasEnglishCost = hasTerm(text, ENGLISH_COST_TERMS)
    if (thaiTerms >= 2) {
      reasons.push('thai_boq_terms')
      score += 0.45
    }
    if (hasEnglishStructure && hasEnglishCost) {
      reasons.push('english_boq_terms')
      score += 0.45
    }
    if (input.geometry.tableCount >= 1) {
      reasons.push('table_layout')
      score += 0.2
    }
    if (input.geometry.numericTokenCount >= 6) {
      reasons.push('numeric_columns')
      score += 0.2
    }
    const hasQuantity = hasTerm(text, QUANTITY_TERMS)
    const hasRate = hasTerm(text, RATE_TERMS)
    const hasAmount = hasTerm(text, AMOUNT_TERMS)
    const quantityRateAmountSignals = [hasQuantity, hasRate, hasAmount].filter(Boolean).length
    if (quantityRateAmountSignals >= 2 && input.geometry.numericTokenCount >= 3) {
      reasons.push('quantity_rate_amount')
      score += 0.15
    }

    const confidence = Math.min(1, Number(score.toFixed(2)))
    return {
      page: input.page,
      suggested: confidence >= PREFLIGHT_HIGH_CONFIDENCE_THRESHOLD,
      confidence,
      reasons,
      textSource: source,
    }
  })
}
