import type { Boq, BoqPricedItem, BoqSourceRef } from './boq-schema'
import type { StandardEntry } from './standard-schema'
import type { ApprovalChoice } from './boq-approval'
import { isPricedBoqItem } from './boq-pricing'
import { qualifyingLocalSuggestions } from './inline-catalog-suggestion'
import { keyWordConflict, rankCatalogMatches } from './standard-matching'

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
  /** Set on AI findings only (see boq-verification AI_ISSUE_CATEGORIES). */
  category?: 'number_error' | 'misread' | 'advisory'
}

export interface RowFlag {
  kind: 'parser' | 'math' | 'ai' | 'catalog'
  text: string
  /** 'important' rows are highlighted; 'note' goes behind a collapsed "Other notes". */
  level: 'important' | 'note'
}

/** Codes that are about wording or scope, never about a wrong number. */
const ADVISORY_CODES = new Set(['description_unclear', 'possible_duplicate', 'metadata_missing'])

/**
 * Deterministic triage of a check finding. Rule findings (no category) are kept
 * prominent unless they are wording-only; AI findings are prominent only when the
 * AI says the numbers are wrong or mis-read AND the code is about numbers/units.
 */
export function issueLevel(issue: Pick<ReviewIssue, 'code' | 'category'>): RowFlag['level'] {
  if (ADVISORY_CODES.has(issue.code)) return 'note'
  if (issue.category === undefined) return 'important'
  return issue.category === 'number_error' || issue.category === 'misread' ? 'important' : 'note'
}

/** Rows with at least one important flag: these are highlighted and counted. */
export function importantRowKeys(flags: ReadonlyMap<string, RowFlag[]>): Set<string> {
  return new Set([...flags].filter(([, list]) => list.some((flag) => flag.level === 'important')).map(([key]) => key))
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
      for (const warning of item.extractionWarnings ?? []) add(key, { kind: 'parser', text: shortParserReason(warning.code, warning.message), level: 'important' })
      if (!isPricedBoqItem(item)) return
      if (Number.isFinite(item.qty) && Number.isFinite(item.rate) && Number.isFinite(item.total)
        && Math.abs(item.qty * item.rate - item.total) > TOLERANCE) {
        add(key, { kind: 'math', text: `Qty × rate = ${(item.qty * item.rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}, but total says ${item.total.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, level: 'important' })
      }
      if (item.qty === 0) add(key, { kind: 'math', text: 'Quantity is 0', level: 'important' })
      if (item.rate === 0 && !item.optional) add(key, { kind: 'math', text: 'Rate is 0', level: 'important' })
    })
  })
  for (const issue of aiIssues) {
    const key = issue.itemId ? keyById.get(issue.itemId)
      : issue.sectionIndex !== undefined && issue.itemIndex !== undefined ? rowKey(issue.sectionIndex, issue.itemIndex) : undefined
    if (!key) continue
    if (issue.code === 'line_total_mismatch') continue // already covered by the math check
    add(key, { kind: 'ai', text: issue.category ? `AI: ${clip(issue.message)}` : clip(issue.message), level: issueLevel(issue) })
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
  /** Why it was picked: 'Saved', 'Exact', 'Alias', 'Similar', 'Chosen', 'None found', 'Unsure'. */
  reason: string
  /** 'Unsure' rows: the closest catalog item, offered first in the picker but NOT selected. */
  suggestedId?: string
}

/** A similar (not exact) best match within this many points of a different runner-up is a coin flip. */
const AMBIGUOUS_MARGIN = 2

/**
 * Why a "similar" best match is too weak to pre-select, or null when it is safe.
 * Exact and alias matches are always safe.
 */
export function weakPickReason(
  item: Pick<BoqPricedItem, 'desc' | 'unit'>,
  standards: StandardEntry[],
  unitMap: Record<string, string>,
): { best: string; why: 'key word differs' | 'two items equally close' } | null {
  const active = standards.filter((standard) => !standard.archivedAt)
  const ranked = rankCatalogMatches(item.desc, item.unit, active, unitMap).filter((candidate) => candidate.unitCompatible && candidate.score > 0)
  const best = ranked[0]
  if (!best || best.matchReason !== 'fuzzy') return null
  if (keyWordConflict(item.desc, best.description, best.aliases)) return { best: best.id, why: 'key word differs' }
  const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')
  const runnerUp = ranked.find((candidate) => candidate.id !== best.id && norm(candidate.description) !== norm(best.description))
  if (runnerUp && best.score - runnerUp.score <= AMBIGUOUS_MARGIN && !keyWordConflict(item.desc, runnerUp.description, runnerUp.aliases)) {
    return { best: best.id, why: 'two items equally close' }
  }
  return null
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
      const weak = best && best.confidence === 'fuzzy' ? weakPickReason(item, standards, unitMap) : null
      if (best && weak) {
        picks.set(key, { standardId: null, reason: 'Unsure', suggestedId: best.standardId })
        return
      }
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
