import type { Boq } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'

/**
 * Duplicate-quote detection. Two signals:
 * - the same PDF file (sha256 of the bytes, stored as `Boq.sourceDigest`), and
 * - the same quote re-scanned: same vendor and date (when both are known), the same
 *   grand total, and nearly the same line totals.
 */
export type DuplicateReason = 'same_file' | 'same_quote'

export interface DuplicateMatch {
  id: string
  project: string
  vendor: string
  date: string
  status: Boq['status']
  grandTotal: number
  approvedAt?: string
  reason: DuplicateReason
}

type QuoteShape = Pick<Boq, 'id' | 'vendor' | 'date' | 'grandTotal' | 'sections'> & Partial<Pick<Boq, 'sourceDigest' | 'project' | 'status' | 'approvedAt'>>

const COMPANY_WORDS = /\b(co|ltd|limited|company|inc|corp|part|partnership)\b|บริษัท|จำกัด|\(มหาชน\)|มหาชน|ห้างหุ้นส่วน|หจก\.?|บจก\.?/giu

export function normalizeVendorName(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(COMPANY_WORDS, '')
    .replace(/[\s.,()\-_/&'"]+/gu, '')
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function lineTotals(quote: QuoteShape): number[] {
  return quote.sections
    .flatMap((section) => section.items)
    .filter(isPricedBoqItem)
    .map((item) => roundMoney(item.total))
    .filter((total) => Number.isFinite(total) && total !== 0)
}

function multisetOverlap(left: number[], right: number[]): number {
  const counts = new Map<number, number>()
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1)
  let shared = 0
  for (const value of right) {
    const remaining = counts.get(value) ?? 0
    if (remaining > 0) {
      shared += 1
      counts.set(value, remaining - 1)
    }
  }
  return shared
}

/** Same vendor + date + total + nearly the same line totals (for re-scans of one quote). */
export function quotesLookSame(left: QuoteShape, right: QuoteShape): boolean {
  if (!(left.grandTotal > 0) || !(right.grandTotal > 0)) return false
  if (Math.abs(left.grandTotal - right.grandTotal) > Math.max(1, left.grandTotal * 0.001)) return false
  const leftVendor = normalizeVendorName(left.vendor)
  const rightVendor = normalizeVendorName(right.vendor)
  const vendorKnown = leftVendor !== '' && rightVendor !== ''
  const dateKnown = left.date.trim() !== '' && right.date.trim() !== ''
  if (vendorKnown && leftVendor !== rightVendor) return false
  if (dateKnown && left.date.trim() !== right.date.trim()) return false
  if (!vendorKnown && !dateKnown) return false
  const leftLines = lineTotals(left)
  const rightLines = lineTotals(right)
  const larger = Math.max(leftLines.length, rightLines.length)
  if (larger < 3) return false
  return multisetOverlap(leftLines, rightLines) / larger >= 0.8
}

/** Exact content key: identical vendor, date, total and every priced line. */
export function quoteContentKey(quote: QuoteShape): string {
  const lines = quote.sections
    .flatMap((section) => section.items)
    .filter(isPricedBoqItem)
    .map((item) => [item.desc.replace(/\s+/g, ' ').trim().toLowerCase(), item.unit.trim().toLowerCase(), roundMoney(item.qty), roundMoney(item.rate), roundMoney(item.total)])
    .map((line) => JSON.stringify(line))
    .sort()
  const payload = JSON.stringify([normalizeVendorName(quote.vendor), quote.date.trim(), roundMoney(quote.grandTotal), lines])
  return `content:${payload}`
}

function toMatch(quote: QuoteShape, reason: DuplicateReason): DuplicateMatch {
  return {
    id: quote.id,
    project: quote.project ?? '',
    vendor: quote.vendor,
    date: quote.date,
    status: quote.status ?? 'draft',
    grandTotal: quote.grandTotal,
    ...(quote.approvedAt ? { approvedAt: quote.approvedAt } : {}),
    reason,
  }
}

/** Other quotes that are the same file. */
export function findSameFile(sourceDigest: string, others: QuoteShape[], excludeId?: string): DuplicateMatch[] {
  if (!sourceDigest) return []
  return others.filter((other) => other.id !== excludeId && other.sourceDigest === sourceDigest).map((other) => toMatch(other, 'same_file'))
}

/** Other quotes that are the same file or look like the same quote. Same-file matches come first. */
export function findDuplicateQuotes(target: QuoteShape, others: QuoteShape[]): DuplicateMatch[] {
  const matches: DuplicateMatch[] = []
  for (const other of others) {
    if (other.id === target.id) continue
    if (target.sourceDigest && other.sourceDigest === target.sourceDigest) matches.push(toMatch(other, 'same_file'))
    else if (quotesLookSame(target, other)) matches.push(toMatch(other, 'same_quote'))
  }
  return matches.sort((left, right) => (left.reason === right.reason ? 0 : left.reason === 'same_file' ? -1 : 1))
}

type CountableQuote = QuoteShape & Pick<Boq, 'status'> & Partial<Pick<Boq, 'duplicateOfBoqId' | 'confirmedDistinctFrom' | 'createdAt'>>

/**
 * Approved quotes whose prices may enter price history. Quotes the user marked as a
 * repeat are left out, and exact repeats (same file, or identical content) are counted
 * once (the earliest approved) unless the user confirmed they are different quotes.
 */
export function countableApprovedQuotes<T extends CountableQuote>(quotes: T[]): T[] {
  const approved = quotes
    .filter((quote) => quote.status === 'approved' && !quote.duplicateOfBoqId)
    .sort((left, right) => (left.approvedAt ?? left.createdAt ?? '').localeCompare(right.approvedAt ?? right.createdAt ?? '') || left.id.localeCompare(right.id))
  const kept: T[] = []
  const seen = new Map<string, T[]>()
  for (const quote of approved) {
    const keys = [quote.sourceDigest ? `file:${quote.sourceDigest}` : null, quoteContentKey(quote)].filter((key): key is string => key !== null)
    const earlier = keys.flatMap((key) => seen.get(key) ?? [])
    const confirmed = new Set(quote.confirmedDistinctFrom ?? [])
    const repeat = earlier.some((other) => !confirmed.has(other.id) && !(other.confirmedDistinctFrom ?? []).includes(quote.id))
    if (repeat) continue
    kept.push(quote)
    for (const key of keys) seen.set(key, [...(seen.get(key) ?? []), quote])
  }
  return kept
}
