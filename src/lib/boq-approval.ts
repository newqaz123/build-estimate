import type { Boq, BoqItem, BoqPricedItem, BoqSection } from './boq-schema'
import type { StandardEntry, StandardSourceItem } from './standard-schema'
import { calculateBoqTotals, isPricedBoqItem } from './boq-pricing'
import { verifyBoqLocally } from './boq-ingestion'
import { getBoqItemIdentity, getBoqItemRequestIdentity } from './boq-item-identity'
import { normalizeStandardEntry } from './catalog-linking'
import { unitsCompatible } from './standard-matching'

/** Plain reason stored on rows the user approved without a catalog item. */
export const NO_CATALOG_ITEM_REASON = 'No catalog item'

/**
 * One catalog choice per priced row. `standardId: null` means "No catalog item".
 * Rows are addressed by section + item index; id/code (when present) must agree,
 * so a stale client cannot link the wrong row.
 */
export interface ApprovalChoice {
  sectionIndex: number
  itemIndex: number
  itemId?: string
  itemCode?: string
  standardId: string | null
  confidence?: NonNullable<BoqItem['stdConfidence']>
}

export interface ApprovalProblem {
  message: string
  sectionIndex?: number
  itemIndex?: number
}

export interface ApprovalPlan {
  boq: Boq
  /** Only the standards whose sourceItems changed. */
  standards: StandardEntry[]
  /** Things that stop Approve (broken data). */
  blocking: ApprovalProblem[]
  /** Shown to the user but never stop Approve. */
  notes: ApprovalProblem[]
  linked: number
  noCatalog: number
}

export class ApprovalError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'ApprovalError'
  }
}

/** Matched or excluded share of priced rows with a positive rate. */
export function computeBoqStdStatus(sections: BoqSection[]): Boq['stdStatus'] {
  const items = sections.flatMap((section) => section.items).filter(isPricedBoqItem).filter((item) => item.rate > 0)
  const done = items.filter((item) => item.stdStatus === 'matched' || item.stdStatus === 'excluded').length
  if (done === 0) return 'none'
  return done === items.length ? 'complete' : 'partial'
}

/** Issue codes that mean the data itself is broken; everything else is a note. */
function isBlockingIssue(issue: { code: string; severity: string; message: string }): boolean {
  if (issue.severity !== 'blocking') return false
  if (issue.code === 'invalid_number' || issue.code === 'items_missing') return true
  if (issue.code === 'metadata_missing') return !/workType/i.test(issue.message)
  return false
}

function linkItem(item: BoqPricedItem, standard: StandardEntry, confidence: NonNullable<BoqItem['stdConfidence']>): BoqPricedItem {
  // Keep the quote's own wording and unit; the link is the catalog id.
  const next: BoqPricedItem = {
    ...item,
    stdId: standard.id,
    stdMatch: standard.description,
    stdStatus: 'matched',
    stdConfidence: confidence,
    sourceDesc: item.sourceDesc ?? item.desc,
    sourceUnit: item.sourceUnit ?? item.unit,
  }
  delete next.stdExclusionReason
  return next
}

function excludeItem(item: BoqPricedItem): BoqPricedItem {
  const next: BoqPricedItem = { ...item, stdStatus: 'excluded', stdExclusionReason: NO_CATALOG_ITEM_REASON }
  delete next.stdId
  delete next.stdMatch
  delete next.stdConfidence
  return next
}

/**
 * Pure plan for the single Approve: apply the user's catalog choices, treat any
 * priced row without a choice as "No catalog item", rebuild this quote's entries
 * in each catalog item's source history, recompute totals, and mark approved.
 * Nothing model-suggested is persisted unless it arrives here as a choice the
 * user approved.
 */
export function planApproval(input: {
  boq: Boq
  standards: StandardEntry[]
  choices: ApprovalChoice[]
  now: string
  unitMap?: Record<string, string>
}): ApprovalPlan {
  const { boq, now } = input
  const unitMap = input.unitMap ?? {}
  if (boq.status === 'approved') throw new ApprovalError('This quote is already approved. Reopen it to edit.', 409)

  const standardsById = new Map(input.standards.filter((standard) => !standard.archivedAt).map((standard) => [standard.id, standard]))
  const choiceByRow = new Map<string, ApprovalChoice>()
  for (const choice of input.choices) {
    const key = `${choice.sectionIndex}:${choice.itemIndex}`
    if (choiceByRow.has(key)) throw new ApprovalError(`Duplicate catalog choice for row ${key}.`)
    choiceByRow.set(key, choice)
  }

  const notes: ApprovalProblem[] = []
  const linkedSources = new Map<string, StandardSourceItem[]>()
  let linked = 0
  let noCatalog = 0

  const sections: BoqSection[] = boq.sections.map((section, sectionIndex) => ({
    ...section,
    items: section.items.map((item, itemIndex) => {
      const choice = choiceByRow.get(`${sectionIndex}:${itemIndex}`)
      if (choice) {
        choiceByRow.delete(`${sectionIndex}:${itemIndex}`)
        const identity = getBoqItemIdentity(item)
        const claimed = choice.itemId?.trim() || choice.itemCode?.trim()
        if (identity && claimed && claimed !== identity.value) {
          throw new ApprovalError('The quote changed since it was loaded. Refresh and try again.', 409)
        }
      }
      if (!isPricedBoqItem(item)) return item
      const standardId = choice ? choice.standardId : (item.stdStatus === 'matched' ? item.stdId ?? null : null)
      const standard = standardId ? standardsById.get(standardId) : undefined
      if (standardId && !standard) throw new ApprovalError(`Catalog item ${standardId} was not found.`)
      if (!standard) {
        noCatalog += 1
        return excludeItem(item)
      }
      if (!unitsCompatible(item.unit, standard.unit, unitMap)) {
        notes.push({
          message: `Unit "${item.unit}" differs from catalog unit "${standard.unit}", so this price will not be used in price history.`,
          sectionIndex,
          itemIndex,
        })
      }
      linked += 1
      const sources = linkedSources.get(standard.id) ?? []
      sources.push({ boqId: boq.id, sectionIndex, ...getBoqItemRequestIdentity(item), sourceDescription: item.sourceDesc ?? item.desc })
      linkedSources.set(standard.id, sources)
      return linkItem(item, standard, choice?.confidence ?? item.stdConfidence ?? 'manual')
    }),
  }))
  if (choiceByRow.size > 0) throw new ApprovalError('A catalog choice points at a row that does not exist.')

  const totals = calculateBoqTotals(sections)
  const nextBoq: Boq = {
    ...boq,
    sections,
    ...totals,
    stdStatus: computeBoqStdStatus(sections),
    status: 'approved',
    approvedAt: now,
    updatedAt: now,
  }

  const verification = verifyBoqLocally(nextBoq)
  const blocking: ApprovalProblem[] = []
  for (const issue of verification.issues) {
    const problem = { message: issue.message, ...(issue.sectionIndex === undefined ? {} : { sectionIndex: issue.sectionIndex }), ...(issue.itemIndex === undefined ? {} : { itemIndex: issue.itemIndex }) }
    if (isBlockingIssue(issue)) blocking.push(problem)
    else notes.push(problem)
  }

  const standards: StandardEntry[] = []
  for (const standard of input.standards) {
    const kept = (standard.sourceItems ?? []).filter((source) => source.boqId !== boq.id)
    const added = linkedSources.get(standard.id) ?? []
    const hadThisBoq = kept.length !== (standard.sourceItems ?? []).length
    if (!hadThisBoq && added.length === 0) continue
    const sourceItems = [...kept, ...added]
    standards.push({
      ...normalizeStandardEntry(standard),
      sourceItems,
      sourceBoqCount: new Set(sourceItems.map((source) => source.boqId)).size,
      ...(added.length > 0 ? { lastMatched: now } : {}),
      updatedAt: now,
    })
  }

  return { boq: nextBoq, standards, blocking, notes, linked, noCatalog }
}

/** Reopen an approved quote: it leaves price history until approved again. */
export function planReopen(input: { boq: Boq; standards: StandardEntry[]; now: string }): { boq: Boq; standards: StandardEntry[] } {
  const { boq, now } = input
  if (boq.status !== 'approved') throw new ApprovalError('Only approved quotes can be reopened.', 409)
  const next: Boq = { ...boq, status: 'review', reopenedAt: now, updatedAt: now }
  delete next.approvedAt
  const standards = input.standards
    .filter((standard) => (standard.sourceItems ?? []).some((source) => source.boqId === boq.id))
    .map((standard) => {
      const sourceItems = (standard.sourceItems ?? []).filter((source) => source.boqId !== boq.id)
      return { ...normalizeStandardEntry(standard), sourceItems, sourceBoqCount: new Set(sourceItems.map((source) => source.boqId)).size, updatedAt: now }
    })
  return { boq: next, standards }
}
