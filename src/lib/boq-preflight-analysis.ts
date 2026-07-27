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
const ENGLISH_BOQ_TERMS = ['description', 'quantity', 'unit', 'material', 'labour', 'labor', 'rate', 'amount', 'total']
const QUANTITY_RATE_AMOUNT_TERMS = ['quantity', 'qty', 'จำนวน', 'rate', 'ราคา', 'amount', 'รวม', 'total']

function normalizedText(input: string): string {
  return input.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

function includesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term))
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

    const thaiTerms = THAI_BOQ_TERMS.filter((term) => text.includes(term)).length
    const englishTerms = ENGLISH_BOQ_TERMS.filter((term) => text.includes(term)).length
    if (thaiTerms >= 2) {
      reasons.push('thai_boq_terms')
      score += 0.45
    }
    if (englishTerms >= 2) {
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
    if (includesAny(text, QUANTITY_RATE_AMOUNT_TERMS) && input.geometry.numericTokenCount >= 3) {
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
