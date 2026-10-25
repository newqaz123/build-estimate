import type { Boq, BoqPricedItem, BoqSourceRef } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import type { ApprovalChoice } from './boq-approval'
import { isPricedBoqItem } from './boq-pricing'
import { qualifyingLocalSuggestions } from './inline-catalog-suggestion'
import { rankCatalogMatches } from './standard-matching'

/** Stable row key used by the review table: `${sectionIndex}:${itemIndex}`. */
export function rowKey(sectionIndex: number, itemIndex: number): string {
  return `${sectionIndex}:${itemIndex}`
}

export interface ReviewIssue {
  code: string
  severity: 'blocking' | 'warning'
  message: string
  itemId?: string
  sectionIndex?: number
  itemIndex?: number
}

export interface RowFlag {
  kind: 'parser' | 'math' | 'ai' | 'catalog'
  text: string
}

const TOLERANCE = 0.01

function shortParserReason(code: string, message: string): string {
  const text = message.trim().replace(/\s+/g, ' ')
  if (/merge|merged|combined/i.test(code) || /merged|combined/i.test(text)) return `Rows were joined: ${clip(text)}`
  if (/ocr/i.test(code)) return `Text read by OCR, check it: ${clip(text)}`
  if (/ambiguous|unmatched/i.test(code)) return `Not sure which PDF row this is: ${clip(text)}`
  return clip(text)
}

function clip(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Short plain reasons per row. Confident rows get no entry at all.
 * Sources: parser warnings on the row, qty × rate ≠ total, zero qty/rate,
 * and issues the AI check pinned to the row (by item id or position).
 */
export function buildRowFlags(boq: Pick<Boq, 'sections'>, aiIssues: ReviewIssue[] = []): Map<string, RowFlag[]> {
  const flags = new Map<string, RowFlag[]>()
  const add = (key: string, flag: RowFlag) => {
    const list = flags.get(key) ?? []
    if (!list.some((existing) => existing.text === flag.text)) list.push(flag)
    flags.set(key, list)
  }
  const keyById = new Map<string, string>()
  boq.sections.forEach((section, sectionIndex) => {
    section.items.forEach((item, itemIndex) => {
      const key = rowKey(sectionIndex, itemIndex)
      if (item.id) keyById.set(item.id, key)
      for (const warning of item.extractionWarnings ?? []) add(key, { kind: 'parser', text: shortParserReason(warning.code, warning.message) })
      if (!isPricedBoqItem(item)) return
      if (Number.isFinite(item.qty) && Number.isFinite(item.rate) && Number.isFinite(item.total)
        && Math.abs(item.qty * item.rate - item.total) > TOLERANCE) {
        add(key, { kind: 'math', text: `Qty × rate = ${(item.qty * item.rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}, but total says ${item.total.toLocaleString('en-US', { maximumFractionDigits: 2 })}` })
      }
      if (item.qty === 0) add(key, { kind: 'math', text: 'Quantity is 0' })
      if (item.rate === 0 && !item.optional) add(key, { kind: 'math', text: 'Rate is 0' })
    })
  })
  for (const issue of aiIssues) {
    const key = issue.itemId ? keyById.get(issue.itemId)
      : issue.sectionIndex !== undefined && issue.itemIndex !== undefined ? rowKey(issue.sectionIndex, issue.itemIndex) : undefined
    if (!key) continue
    if (issue.code === 'line_total_mismatch') continue // already covered by the math check
    add(key, { kind: 'ai', text: `AI: ${clip(issue.message)}` })
  }
  return flags
}

/** Quote-level notes (totals that disagree with the PDF, AI notes without a row). */
export function buildQuoteNotes(issues: ReviewIssue[], rowKeys: ReadonlySet<string>, itemIds: ReadonlySet<string>): string[] {
  const notes: string[] = []
  for (const issue of issues) {
    const pinned = (issue.itemId && itemIds.has(issue.itemId))
      || (issue.sectionIndex !== undefined && issue.itemIndex !== undefined && rowKeys.has(rowKey(issue.sectionIndex, issue.itemIndex)))
    if (pinned) continue
    if (issue.code === 'metadata_missing' || issue.code === 'line_total_mismatch' || issue.code === 'invalid_number') continue
    const text = issue.code === 'document_total_mismatch' ? 'Sum of rows does not match the total printed on the PDF.'
      : issue.code === 'grand_total_mismatch' ? 'Grand total does not match the rows.'
        : clip(issue.message, 200)
    if (!notes.includes(text)) notes.push(text)
  }
  return notes
}

export interface CatalogPick {
  standardId: string | null
  confidence?: NonNullable<BoqPricedItem['stdConfidence']>
  /** Why it was picked: 'Saved', 'Exact', 'Alias', 'Similar', 'Chosen', 'None found'. */
  reason: string
}

/**
 * Best catalog item per priced row, pre-selected for the user. Existing links are
 * kept; otherwise the top unit-compatible exact/alias/strong-fuzzy match; else none.
 */
export function preselectCatalog(boq: Pick<Boq, 'sections'>, standards: StandardEntry[], unitMap: Record<string, string>): Map<string, CatalogPick> {
  const picks = new Map<string, CatalogPick>()
  const active = new Set(standards.filter((standard) => !standard.archivedAt).map((standard) => standard.id))
  boq.sections.forEach((section, sectionIndex) => {
    section.items.forEach((item, itemIndex) => {
      if (!isPricedBoqItem(item)) return
      const key = rowKey(sectionIndex, itemIndex)
      if (item.stdStatus === 'matched' && item.stdId && active.has(item.stdId)) {
        picks.set(key, { standardId: item.stdId, confidence: item.stdConfidence ?? 'manual', reason: 'Saved' })
        return
      }
      if (item.stdStatus === 'excluded') {
        picks.set(key, { standardId: null, reason: 'Saved' })
        return
      }
      const best = qualifyingLocalSuggestions({ ...item, stdStatus: 'unmatched' }, standards, unitMap)[0]
      picks.set(key, best
        ? { standardId: best.standardId, confidence: best.confidence === 'llm' ? 'llm' : best.confidence, reason: best.reason }
        : { standardId: null, reason: 'None found' })
    })
  })
  return picks
}

/** Catalog items for the picker, best first; an empty query ranks by the row text. */
export function searchCatalog(query: string, item: Pick<BoqPricedItem, 'desc' | 'unit'>, standards: StandardEntry[], unitMap: Record<string, string>, limit = 8): StandardEntry[] {
  const active = standards.filter((standard) => !standard.archivedAt)
  const text = query.trim()
  const ranked = rankCatalogMatches(text || item.desc, text ? '' : item.unit, active, unitMap)
  const byId = new Map(active.map((standard) => [standard.id, standard]))
  const scored = ranked.filter((candidate) => candidate.score > 0)
  const needle = text.toLowerCase()
  const contains = needle ? active.filter((standard) => standard.description.toLowerCase().includes(needle)) : []
  const ids = [...new Set([...contains.map((s) => s.id), ...scored.map((c) => c.id)])]
  return ids.slice(0, limit).map((id) => byId.get(id)!).filter(Boolean)
}

export function buildApprovalChoices(boq: Pick<Boq, 'sections'>, picks: ReadonlyMap<string, CatalogPick>): ApprovalChoice[] {
  const choices: ApprovalChoice[] = []
  boq.sections.forEach((section, sectionIndex) => {
    section.items.forEach((item, itemIndex) => {
      if (!isPricedBoqItem(item)) return
      const pick = picks.get(rowKey(sectionIndex, itemIndex))
      choices.push({
        sectionIndex,
        itemIndex,
        ...(item.id ? { itemId: item.id } : item.code ? { itemCode: item.code } : {}),
        standardId: pick?.standardId ?? null,
        ...(pick?.standardId && pick.confidence ? { confidence: pick.confidence } : {}),
      })
    })
  })
  return choices
}

/** PDF location for a row, if the parser recorded one. */
export function rowSourceRef(item: { sourceRef?: BoqSourceRef }): BoqSourceRef | undefined {
  const ref = item.sourceRef
  return ref && Number.isInteger(ref.page) && ref.page > 0 ? ref : undefined
}
