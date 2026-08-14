import type { BoqSourceRef } from './boq-schema'
import { addDecimal, parseDecimalString, type DecimalString } from './decimal-string'

/**
 * Fixed commercial evidence lifted verbatim from the source quotation.
 * Amounts are canonical nonnegative decimal strings and arithmetic closes
 * exactly: direct work plus overhead/profit equals the quoted subtotal, and
 * the discount closes the quoted subtotal to the payable total.
 */
export interface BoqSourceQuoteSummary {
  directWorkTotal: DecimalString
  overheadProfitAmount?: DecimalString
  quotedSubtotal: DecimalString
  discountAmount?: DecimalString
  payableTotal?: DecimalString
  overheadProfitSourceRef?: BoqSourceRef
  discountSourceRef?: BoqSourceRef
  subtotalSourceRef?: BoqSourceRef
  payableTotalSourceRef?: BoqSourceRef
}

const SUMMARY_KEYS = [
  'directWorkTotal',
  'overheadProfitAmount',
  'quotedSubtotal',
  'discountAmount',
  'payableTotal',
  'overheadProfitSourceRef',
  'discountSourceRef',
  'subtotalSourceRef',
  'payableTotalSourceRef',
] as const

// Mirrors the sidecar CANONICAL_DECIMAL contract: no sign, no exponent, no
// leading zeros, and no trailing-zero fraction digits.
const CANONICAL_NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/

function invalid(path: string, expectation: string): never {
  throw new TypeError(`Invalid source quote summary: ${path} must be ${expectation}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, 'an object')
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) invalid(path, `contain no unknown field ${JSON.stringify(unknown)}`)
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalid(path, 'an integer greater than or equal to 1')
  }
  return value
}

function locationKey(ref: BoqSourceRef): string {
  return `${ref.page}:${ref.table}:${ref.row}`
}

function canonicalAmount(value: unknown, path: string): DecimalString {
  if (typeof value !== 'string' || !CANONICAL_NONNEGATIVE_DECIMAL.test(value)) {
    invalid(path, 'a canonical nonnegative decimal string')
  }
  return parseDecimalString(value)
}

/**
 * Serialize a finite JSON number as a canonical decimal string without
 * exponent notation, mirroring the sidecar checked float round trip.
 */
export function canonicalDecimalFromFloat(value: number, path: string): DecimalString {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(path, 'remain within the finite JSON-number range')
  }
  let text = String(value)
  if (/[eE]/.test(text)) {
    const negative = text.startsWith('-')
    const unsigned = negative ? text.slice(1) : text
    const [mantissa, exponentText] = unsigned.toLowerCase().split('e')
    const exponent = Number(exponentText)
    const point = mantissa.indexOf('.')
    const fractionDigits = point === -1 ? 0 : mantissa.length - point - 1
    const digits = mantissa.replace('.', '')
    const scale = fractionDigits - exponent
    let plain: string
    if (scale <= 0) {
      plain = `${digits}${'0'.repeat(-scale)}`
    } else if (digits.length <= scale) {
      plain = `0.${'0'.repeat(scale - digits.length)}${digits}`
    } else {
      plain = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`
    }
    text = `${negative ? '-' : ''}${plain}`
  }
  return parseDecimalString(text)
}

function isStrictlyBelowMinorUnit(magnitude: DecimalString): boolean {
  const point = magnitude.indexOf('.')
  const whole = point === -1 ? magnitude : magnitude.slice(0, point)
  const fraction = point === -1 ? '' : magnitude.slice(point + 1)
  return whole === '0' && (fraction === '' || fraction.startsWith('00'))
}

/**
 * Mirror of the sidecar sub-minor-unit boundary: legacy float representation
 * differences strictly below one currency minor unit (0.01) pass while one
 * minor unit or more fails. Never rounds, so half-minor-unit differences
 * such as 120.005 against 120 stay acceptable exactly as in the sidecar.
 */
export function isSubMinorUnitDifference(left: DecimalString, right: DecimalString): boolean {
  const difference = addDecimal(left, `-${right}`)
  const magnitude = difference.startsWith('-') ? difference.slice(1) : difference
  return isStrictlyBelowMinorUnit(magnitude)
}

function summarySourceRef(
  value: unknown,
  path: string,
  knownLocations: ReadonlySet<string>,
): BoqSourceRef {
  const ref = record(value, path)
  exactKeys(ref, ['page', 'table', 'row'], path)
  const parsed: BoqSourceRef = {
    page: integer(ref.page, `${path}.page`),
    table: integer(ref.table, `${path}.table`),
    row: integer(ref.row, `${path}.row`),
  }
  if (!knownLocations.has(locationKey(parsed))) invalid(path, 'reference a known source row location')
  return parsed
}

export function parseSourceQuoteSummary(
  value: unknown,
  options: {
    directWorkTotal: DecimalString
    sourceTotal: DecimalString
    knownLocations: ReadonlySet<string>
  },
): BoqSourceQuoteSummary {
  const input = record(value, 'sourceQuoteSummary')
  exactKeys(input, SUMMARY_KEYS, 'sourceQuoteSummary')

  const directWorkTotal = canonicalAmount(input.directWorkTotal, 'sourceQuoteSummary.directWorkTotal')
  const overheadProfitAmount = input.overheadProfitAmount === undefined
    ? undefined
    : canonicalAmount(input.overheadProfitAmount, 'sourceQuoteSummary.overheadProfitAmount')
  const quotedSubtotal = canonicalAmount(input.quotedSubtotal, 'sourceQuoteSummary.quotedSubtotal')
  const discountAmount = input.discountAmount === undefined
    ? undefined
    : canonicalAmount(input.discountAmount, 'sourceQuoteSummary.discountAmount')
  const payableTotal = input.payableTotal === undefined
    ? undefined
    : canonicalAmount(input.payableTotal, 'sourceQuoteSummary.payableTotal')

  if (directWorkTotal !== options.directWorkTotal) {
    invalid('sourceQuoteSummary.directWorkTotal', 'match the checked direct contributing-item total')
  }
  if (addDecimal(directWorkTotal, overheadProfitAmount ?? '0') !== quotedSubtotal) {
    invalid('sourceQuoteSummary.quotedSubtotal', 'equal direct work plus overhead or profit')
  }
  if ((discountAmount === undefined) !== (payableTotal === undefined)) {
    invalid('sourceQuoteSummary.discountAmount', 'be present with a payable total or absent together')
  }
  if (discountAmount !== undefined && payableTotal !== undefined
    && addDecimal(quotedSubtotal, `-${discountAmount}`) !== payableTotal) {
    invalid('sourceQuoteSummary.payableTotal', 'equal the quoted subtotal minus the discount')
  }
  const legacyQuoted = canonicalDecimalFromFloat(Number(quotedSubtotal), 'sourceQuoteSummary.quotedSubtotal')
  if (!isSubMinorUnitDifference(legacyQuoted, options.sourceTotal)) {
    invalid('sourceTotal', 'matching sourceQuoteSummary.quotedSubtotal within a sub-minor-unit difference')
  }

  const overheadProfitSourceRef = input.overheadProfitSourceRef === undefined
    ? undefined
    : summarySourceRef(input.overheadProfitSourceRef, 'sourceQuoteSummary.overheadProfitSourceRef', options.knownLocations)
  const discountSourceRef = input.discountSourceRef === undefined
    ? undefined
    : summarySourceRef(input.discountSourceRef, 'sourceQuoteSummary.discountSourceRef', options.knownLocations)
  const subtotalSourceRef = input.subtotalSourceRef === undefined
    ? undefined
    : summarySourceRef(input.subtotalSourceRef, 'sourceQuoteSummary.subtotalSourceRef', options.knownLocations)
  const payableTotalSourceRef = input.payableTotalSourceRef === undefined
    ? undefined
    : summarySourceRef(input.payableTotalSourceRef, 'sourceQuoteSummary.payableTotalSourceRef', options.knownLocations)

  return {
    directWorkTotal,
    ...(overheadProfitAmount === undefined ? {} : { overheadProfitAmount }),
    quotedSubtotal,
    ...(discountAmount === undefined ? {} : { discountAmount }),
    ...(payableTotal === undefined ? {} : { payableTotal }),
    ...(overheadProfitSourceRef === undefined ? {} : { overheadProfitSourceRef }),
    ...(discountSourceRef === undefined ? {} : { discountSourceRef }),
    ...(subtotalSourceRef === undefined ? {} : { subtotalSourceRef }),
    ...(payableTotalSourceRef === undefined ? {} : { payableTotalSourceRef }),
  }
}

/**
 * Quote-summary projection consumed by approval reconciliation: the quoted
 * subtotal bridges direct items to the source document, and the payable total
 * carries any closed discount forward when present.
 */
export function quoteSummaryReconciliation(
  summary: BoqSourceQuoteSummary,
): { quotedSubtotal: DecimalString; payableTotal?: DecimalString } {
  return {
    quotedSubtotal: summary.quotedSubtotal,
    ...(summary.payableTotal === undefined ? {} : { payableTotal: summary.payableTotal }),
  }
}
