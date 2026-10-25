/**
 * Merge two or more catalog entries into one.
 *
 * The kept entry takes the chosen name, unit and aliases plus every source row
 * of the merged entries (via mergeStandardSourceItems). Quote rows, estimate
 * rows and per-item unit conversions that pointed at a merged entry are
 * repointed to the kept one. Merged entries are archived (never deleted) and
 * the kept entry remembers enough to undo the last merge.
 */
import type { Boq } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import { buildCatalogHistoricalPricing, type HistoricalPriceSummary } from './catalog-historical-pricing'
import { findDuplicateStandard, mergeStandardSourceItems, normalizeStandardEntry } from './catalog-linking'
import type { Estimate } from './estimate-schema'
import { unitMatchKey } from './standard-matching'
import type { StandardEntry, StandardSourceItem } from './standard-schema'

export interface CatalogMergeInput {
  keepId: string
  mergeIds: string[]
  description: string
  unit: string
  aliases: string[]
}

export interface MergeUndoRecord {
  at: string
  mergedIds: string[]
  previous: {
    description: string
    unit: string
    aliases: string[]
    sourceItems: StandardSourceItem[]
    sourceBoqCount: number
    lastMatched?: string
  }
  rows: Array<{ boqId: string; sectionIndex: number; itemIndex: number; itemId?: string; fromId: string }>
  estimateRows: Array<{ estimateId: string; itemIndex: number; fromId: string }>
  rules: Array<{ id: string; fromId: string }>
}

/** Stored on the kept entry (lastMerge) and on archived entries (mergedInto). */
export type MergeAwareStandard = StandardEntry

export class CatalogMergeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'CatalogMergeError'
  }
}

const textKey = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

function uniqueText(values: Iterable<string>, exclude: string[] = []): string[] {
  const seen = new Set(exclude.map(textKey))
  const out: string[] = []
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed || seen.has(textKey(trimmed))) continue
    seen.add(textKey(trimmed))
    out.push(trimmed)
  }
  return out
}

export function parseCatalogMergeInput(body: unknown): CatalogMergeInput {
  if (!body || typeof body !== 'object') throw new CatalogMergeError('Invalid merge request.')
  const value = body as Record<string, unknown>
  const keepId = typeof value.keepId === 'string' ? value.keepId.trim() : ''
  const mergeIds = Array.isArray(value.mergeIds) ? uniqueText(value.mergeIds.filter((id): id is string => typeof id === 'string')) : []
  if (!keepId) throw new CatalogMergeError('Choose which item to keep.')
  const others = mergeIds.filter((id) => id !== keepId)
  if (!others.length) throw new CatalogMergeError('Pick at least two items to merge.')
  if (value.aliases !== undefined && !Array.isArray(value.aliases)) throw new CatalogMergeError('Aliases must be a list.')
  return {
    keepId,
    mergeIds: others,
    description: typeof value.description === 'string' ? value.description.trim() : '',
    unit: typeof value.unit === 'string' ? value.unit.trim() : '',
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
  }
}

function pickEntries(standards: StandardEntry[], ids: string[]): StandardEntry[] {
  const byId = new Map(standards.map((standard) => [standard.id, standard]))
  return ids.map((id) => {
    const entry = byId.get(id)
    if (!entry) throw new CatalogMergeError('One of the items no longer exists. Refresh and try again.', 404)
    if (entry.archivedAt) throw new CatalogMergeError(`"${entry.description}" is archived and can't be merged.`, 409)
    return normalizeStandardEntry(entry)
  })
}

/** Default kept name/unit/aliases: the kept entry's, plus the other names as aliases. */
export function suggestMergeFields(keep: StandardEntry, others: StandardEntry[], description = keep.description) {
  return {
    description,
    unit: keep.unit,
    aliases: uniqueText(
      [keep.description, ...keep.aliases, ...others.flatMap((other) => [other.description, ...other.aliases])],
      [description],
    ),
  }
}

export interface PlannedCatalogMerge {
  kept: MergeAwareStandard
  archived: MergeAwareStandard[]
  boqs: Boq[]
  estimates: Estimate[]
  rules: HumanApprovedCatalogConversionRule[]
  undo: MergeUndoRecord
}

export function planCatalogMerge(args: {
  standards: StandardEntry[]
  boqs: Boq[]
  estimates?: Estimate[]
  rules?: HumanApprovedCatalogConversionRule[]
  input: CatalogMergeInput
  now: string
  unitMap?: Record<string, string>
}): PlannedCatalogMerge {
  const { standards, boqs, estimates = [], rules = [], input, now, unitMap = {} } = args
  const [keep, ...others] = pickEntries(standards, [input.keepId, ...input.mergeIds])
  const description = input.description || keep!.description
  const suggested = suggestMergeFields(keep!, others, description)
  const unit = input.unit || suggested.unit
  const mergedIds = others.map((other) => other.id)
  const mergedSet = new Set(mergedIds)
  const clash = findDuplicateStandard(standards, description, unit, unitMap, [keep!.id, ...mergedIds])
  if (clash) throw new CatalogMergeError(`"${clash.description}" (${clash.unit}) already exists. Include it in the merge or pick another name.`, 409)

  let kept: StandardEntry = normalizeStandardEntry(keep!)
  for (const other of others) {
    for (const source of other.sourceItems ?? []) kept = mergeStandardSourceItems(kept, source, kept.lastMatched ?? now)
  }
  const lastMatched = [keep!, ...others].map((entry) => entry.lastMatched).filter((value): value is string => Boolean(value)).sort().pop()

  const undo: MergeUndoRecord = {
    at: now,
    mergedIds,
    previous: {
      description: keep!.description,
      unit: keep!.unit,
      aliases: [...keep!.aliases],
      sourceItems: (keep!.sourceItems ?? []).map((item) => ({ ...item })),
      sourceBoqCount: keep!.sourceBoqCount ?? 0,
      ...(keep!.lastMatched ? { lastMatched: keep!.lastMatched } : {}),
    },
    rows: [],
    estimateRows: [],
    rules: [],
  }

  const nextKept: MergeAwareStandard = {
    ...kept,
    description,
    unit,
    aliases: uniqueText(input.aliases.length ? input.aliases : suggested.aliases, [description]),
    sourceBoqCount: new Set((kept.sourceItems ?? []).map((item) => item.boqId)).size,
    updatedAt: now,
    lastMerge: undo,
  }
  if (lastMatched) nextKept.lastMatched = lastMatched
  else delete nextKept.lastMatched

  const changedBoqs: Boq[] = []
  for (const boq of boqs) {
    let changed = false
    const sections = boq.sections.map((section, sectionIndex) => ({
      ...section,
      items: section.items.map((item, itemIndex) => {
        if (!isPricedBoqItem(item) || !item.stdId || !mergedSet.has(item.stdId)) return item
        changed = true
        undo.rows.push({ boqId: boq.id, sectionIndex, itemIndex, ...(item.id ? { itemId: item.id } : {}), fromId: item.stdId })
        return { ...item, stdId: nextKept.id, ...(item.stdMatch !== undefined ? { stdMatch: nextKept.description } : {}) }
      }),
    }))
    if (changed) changedBoqs.push({ ...boq, sections, updatedAt: now })
  }

  const changedEstimates: Estimate[] = []
  for (const estimate of estimates) {
    let changed = false
    const items = estimate.items.map((item, itemIndex) => {
      if (!item.stdId || !mergedSet.has(item.stdId)) return item
      changed = true
      undo.estimateRows.push({ estimateId: estimate.id, itemIndex, fromId: item.stdId })
      return { ...item, stdId: nextKept.id }
    })
    if (changed) changedEstimates.push({ ...estimate, items })
  }

  const changedRules: HumanApprovedCatalogConversionRule[] = []
  for (const rule of rules) {
    if (rule.archivedAt || rule.scope !== 'catalog_item' || !rule.catalogId || !mergedSet.has(rule.catalogId)) continue
    undo.rules.push({ id: rule.id, fromId: rule.catalogId })
    changedRules.push({ ...rule, catalogId: nextKept.id, version: rule.version + 1 })
  }

  const archived = others.map((other) => ({ ...other, archivedAt: now, mergedInto: nextKept.id, updatedAt: now }))
  return { kept: nextKept, archived, boqs: changedBoqs, estimates: changedEstimates, rules: changedRules, undo }
}

export interface CatalogMergePreview {
  entries: Array<{ id: string; description: string; unit: string; aliases: string[]; linkedRows: number; history: HistoricalPriceSummary | null }>
  suggested: { description: string; unit: string; aliases: string[] }
  combined: HistoricalPriceSummary | null
  unitsDiffer: boolean
  linkedRows: number
  conversions: number
}

export function previewCatalogMerge(args: {
  standards: StandardEntry[]
  boqs: Boq[]
  rules?: HumanApprovedCatalogConversionRule[]
  unitMap?: Record<string, string>
  input: CatalogMergeInput
}): CatalogMergePreview {
  const { standards, boqs, rules = [], unitMap = {}, input } = args
  const [keep, ...others] = pickEntries(standards, [input.keepId, ...input.mergeIds])
  const history = buildCatalogHistoricalPricing(standards, boqs, unitMap)
  const linked = new Map<string, number>()
  for (const boq of boqs) for (const section of boq.sections) for (const item of section.items) {
    if (isPricedBoqItem(item) && item.stdId) linked.set(item.stdId, (linked.get(item.stdId) ?? 0) + 1)
  }
  const plan = planCatalogMerge({ standards, boqs, rules, unitMap, input: { ...input, description: input.description || keep!.description, unit: input.unit || keep!.unit }, now: new Date(0).toISOString() })
  const plannedBoqs = boqs.map((boq) => plan.boqs.find((next) => next.id === boq.id) ?? boq)
  const plannedStandards = standards.map((standard) => (standard.id === plan.kept.id ? plan.kept : plan.archived.find((entry) => entry.id === standard.id) ?? standard))
  const combined = buildCatalogHistoricalPricing(plannedStandards, plannedBoqs, unitMap).get(plan.kept.id) ?? null
  const entries = [keep!, ...others].map((entry) => ({
    id: entry.id, description: entry.description, unit: entry.unit, aliases: entry.aliases,
    linkedRows: linked.get(entry.id) ?? 0, history: history.get(entry.id) ?? null,
  }))
  return {
    entries,
    suggested: suggestMergeFields(keep!, others),
    combined,
    unitsDiffer: new Set(entries.map((entry) => unitMatchKey(entry.unit, unitMap))).size > 1,
    linkedRows: entries.reduce((sum, entry) => sum + entry.linkedRows, 0),
    conversions: plan.rules.length,
  }
}

export interface PlannedMergeUndo {
  kept: MergeAwareStandard
  restored: MergeAwareStandard[]
  boqs: Boq[]
  estimates: Estimate[]
  rules: HumanApprovedCatalogConversionRule[]
}

/** Undo the last merge into keepId: restore the kept entry, unarchive the others, point rows back. */
export function planCatalogMergeUndo(args: {
  standards: MergeAwareStandard[]
  boqs: Boq[]
  estimates?: Estimate[]
  rules?: HumanApprovedCatalogConversionRule[]
  keepId: string
  now: string
}): PlannedMergeUndo {
  const { standards, boqs, estimates = [], rules = [], keepId, now } = args
  const keep = standards.find((standard) => standard.id === keepId)
  if (!keep) throw new CatalogMergeError('Item not found.', 404)
  const record = keep.lastMerge
  if (!record) throw new CatalogMergeError('There is no merge to undo for this item.', 409)
  const byId = new Map(standards.map((standard) => [standard.id, standard]))

  const kept: MergeAwareStandard = { ...keep, ...record.previous, updatedAt: now }
  delete kept.lastMerge
  if (!record.previous.lastMatched) delete kept.lastMatched
  const restored = record.mergedIds.map((id) => {
    const entry = byId.get(id)
    if (!entry) throw new CatalogMergeError('A merged item is missing; the merge cannot be undone.', 409)
    const next: MergeAwareStandard = { ...entry, updatedAt: now }
    delete next.archivedAt
    delete next.mergedInto
    return next
  })
  const names = new Map(restored.map((entry) => [entry.id, entry.description]))

  const boqById = new Map(boqs.map((boq) => [boq.id, structuredClone(boq)]))
  const touched = new Set<string>()
  for (const ref of record.rows) {
    const boq = boqById.get(ref.boqId)
    const item = boq?.sections[ref.sectionIndex]?.items[ref.itemIndex]
    if (!boq || !item || !isPricedBoqItem(item) || item.stdId !== keepId || (ref.itemId && item.id !== ref.itemId)) continue
    item.stdId = ref.fromId
    if (item.stdMatch !== undefined) item.stdMatch = names.get(ref.fromId) ?? item.stdMatch
    boq.updatedAt = now
    touched.add(boq.id)
  }
  const estimateById = new Map(estimates.map((estimate) => [estimate.id, structuredClone(estimate)]))
  const touchedEstimates = new Set<string>()
  for (const ref of record.estimateRows) {
    const item = estimateById.get(ref.estimateId)?.items[ref.itemIndex]
    if (!item || item.stdId !== keepId) continue
    item.stdId = ref.fromId
    touchedEstimates.add(ref.estimateId)
  }
  const changedRules: HumanApprovedCatalogConversionRule[] = []
  for (const ref of record.rules) {
    const rule = rules.find((candidate) => candidate.id === ref.id)
    if (!rule || rule.catalogId !== keepId) continue
    changedRules.push({ ...rule, catalogId: ref.fromId, version: rule.version + 1 })
  }
  return {
    kept,
    restored,
    boqs: [...touched].map((id) => boqById.get(id)!),
    estimates: [...touchedEstimates].map((id) => estimateById.get(id)!),
    rules: changedRules,
  }
}
