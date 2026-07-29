import type { Boq, BoqItem, BoqPricedItem } from '@/lib/boq-schema'
import { getBoqItemIdentityKey, resolveBoqItemIdentity, type BoqItemRequestIdentity } from '@/lib/boq-item-identity'
import type { StandardEntry } from '@/lib/standard-schema'
import { applyManualCostAllocation, costAllocationReconciles, deriveSourceCostAllocation } from '@/lib/boq-cost-allocation'
import { calculateBoqTotals, isPricedBoqItem } from '@/lib/boq-pricing'
import { applyStandardToBoqItem } from '../../../standards/route'

export interface BoqItemUpdate {
  itemId?: string
  itemCode?: string
  code?: string
  desc?: string
  unit?: string
  qty?: number
  rate?: number
  total?: number
  materialCost?: number
  labourCost?: number
  type?: BoqPricedItem['type']
  stdStatus?: BoqItem['stdStatus'] | 'fuzzy' | 'llm'
  stdMatch?: string
  stdExclusionReason?: string
  excludedFromTotal?: boolean
}

export interface BoqItemUpdateGroup {
  sectionIndex: number
  items: BoqItemUpdate[]
}

export class BoqItemsValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'BoqItemsValidationError'
  }
}

const ALLOWED_STD_STATUSES = new Set(['matched', 'unmatched', 'pending', 'excluded', 'fuzzy', 'llm'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStandard(entry: StandardEntry): StandardEntry {
  return { ...entry, aliases: entry.aliases ?? [], sourceItems: entry.sourceItems ?? [] }
}

function computeTotals(sections: Boq['sections']) {
  return calculateBoqTotals(sections)
}

function computeStdStatus(sections: Boq['sections']): Boq['stdStatus'] {
  const items = sections.flatMap((section) => section.items).filter(isPricedBoqItem).filter((item) => item.rate > 0)
  const resolved = items.filter((item) => item.stdStatus === 'matched' || item.stdStatus === 'excluded').length
  if (items.length === 0 || resolved === 0) return 'none'
  return resolved === items.length ? 'complete' : 'partial'
}

function normalizeLinkValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function makeLinkKey(boqId: string, sectionIndex: number, identityKey: string): string {
  return JSON.stringify([boqId, sectionIndex, identityKey])
}

function collectStandardLinks(
  boqs: Boq[],
  standard: StandardEntry,
  previousStandard: StandardEntry = standard,
): Map<string, string> {
  const sourceKeys = new Set(
    [standard.sourceItems, previousStandard.sourceItems]
      .flatMap((items) => Array.isArray(items) ? items : [])
      .flatMap((source) => {
        if (!source || typeof source.boqId !== 'string' || !Number.isInteger(source.sectionIndex)) return []
        const identityKey = typeof source.itemId === 'string' && source.itemId.trim()
          ? `id:${source.itemId.trim()}`
          : typeof source.itemCode === 'string' && source.itemCode.trim()
            ? `code:${source.itemCode.trim()}`
            : undefined
        return identityKey ? [makeLinkKey(source.boqId, source.sectionIndex, identityKey)] : []
      }),
  )
  const canonicalValues = new Set([
    `${normalizeLinkValue(standard.description)}:${normalizeLinkValue(standard.unit)}`,
    `${normalizeLinkValue(previousStandard.description)}:${normalizeLinkValue(previousStandard.unit)}`,
  ])
  const links = new Map<string, string>()

  for (const boq of boqs) {
    boq.sections.forEach((section, sectionIndex) => {
      section.items.forEach((item) => {
        if (!isPricedBoqItem(item)) return
        const identityKey = getBoqItemIdentityKey(item)
        if (!identityKey) return
        const key = makeLinkKey(boq.id, sectionIndex, identityKey)
        const provenanceMatch = sourceKeys.has(key) && (!item.stdId || item.stdId === standard.id)
        const canonicalMatch = !item.stdId && canonicalValues.has(
          `${normalizeLinkValue(item.desc)}:${normalizeLinkValue(item.unit)}`,
        )
        if (item.stdId === standard.id || provenanceMatch || canonicalMatch) links.set(key, boq.id)
      })
    })
  }
  return links
}

export function countBoqStandardLinks(
  boqs: Boq[],
  standard: StandardEntry,
): { affectedLinkCount: number; affectedBoqCount: number } {
  const links = collectStandardLinks(boqs, standard)
  return { affectedLinkCount: links.size, affectedBoqCount: new Set(links.values()).size }
}

function validateUpdate(value: unknown): BoqItemRequestIdentity {
  if (!isRecord(value)) throw new BoqItemsValidationError('Each item update must be an object.')
  const update = value as BoqItemUpdate
  if ('itemId' in value && typeof value.itemId !== 'string') throw new BoqItemsValidationError('itemId must be a string.')
  if ('itemCode' in value && typeof value.itemCode !== 'string') throw new BoqItemsValidationError('itemCode must be a string.')
  if ('code' in value && typeof value.code !== 'string') throw new BoqItemsValidationError('code must be a string.')
  if ('stdStatus' in value && (typeof value.stdStatus !== 'string' || !ALLOWED_STD_STATUSES.has(value.stdStatus))) {
    throw new BoqItemsValidationError('stdStatus is invalid.')
  }
  if ('stdMatch' in value && typeof value.stdMatch !== 'string') throw new BoqItemsValidationError('stdMatch must be a string.')
  if ('stdExclusionReason' in value && typeof value.stdExclusionReason !== 'string') throw new BoqItemsValidationError('stdExclusionReason must be a string.')
  if ('excludedFromTotal' in value && typeof value.excludedFromTotal !== 'boolean') throw new BoqItemsValidationError('excludedFromTotal must be a boolean.')

  const itemId = update.itemId?.trim()
  const itemCode = (update.itemCode ?? update.code)?.trim()
  if ((!itemId && !itemCode) || (itemId?.length ?? 0) > 200 || (itemCode?.length ?? 0) > 200) {
    throw new BoqItemsValidationError('Each item update requires a non-empty itemId or itemCode identity.')
  }
  if (update.code !== undefined && (!update.code.trim() || update.code.trim().length > 200)) {
    throw new BoqItemsValidationError('code must be a non-empty string.')
  }
  if (update.desc !== undefined && !update.desc.trim()) throw new BoqItemsValidationError('Description cannot be empty.')
  if (update.unit !== undefined && !update.unit.trim()) throw new BoqItemsValidationError('Unit cannot be empty.')
  for (const [field, fieldValue] of [['qty', update.qty], ['rate', update.rate], ['total', update.total], ['materialCost', update.materialCost], ['labourCost', update.labourCost]] as const) {
    if (fieldValue !== undefined && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0)) {
      throw new BoqItemsValidationError(`${field} must be a finite non-negative number.`)
    }
    if ((field === 'materialCost' || field === 'labourCost') && fieldValue !== undefined) {
      const scaled = Math.round(fieldValue * 100)
      if (Math.abs(scaled / 100 - fieldValue) > 1e-9) {
        throw new BoqItemsValidationError(`${field} must have at most 2 decimal places.`)
      }
    }
  }
  if (update.type !== undefined && !['unit', 'lump_sum', 'job'].includes(update.type)) {
    throw new BoqItemsValidationError('type is invalid.')
  }
  if (update.stdStatus === 'matched') {
    throw new BoqItemsValidationError('Matched items must be linked through POST /api/standards/match.')
  }
  return { ...(itemId ? { itemId } : {}), ...(itemCode ? { itemCode } : {}) }
}

export function parseUpdateGroups(body: unknown): BoqItemUpdateGroup[] {
  if (!isRecord(body)) throw new BoqItemsValidationError('Request body must be an object.')
  const hasBatch = 'updates' in body
  if (hasBatch && !Array.isArray(body.updates)) throw new BoqItemsValidationError('updates must be an array.')
  if (!hasBatch && !Array.isArray(body.items)) throw new BoqItemsValidationError('items must be an array.')
  const groups: unknown[] = hasBatch ? body.updates as unknown[] : [{ sectionIndex: body.sectionIndex, items: body.items }]
  if (groups.length === 0) throw new BoqItemsValidationError('At least one section update is required.')

  return groups.map((group) => {
    if (!isRecord(group)) throw new BoqItemsValidationError('Invalid section update.')
    if (typeof group.sectionIndex !== 'number' || !Number.isInteger(group.sectionIndex) || group.sectionIndex < 0 || !Array.isArray(group.items)) {
      throw new BoqItemsValidationError('sectionIndex and items are required.')
    }
    if (group.items.length === 0) throw new BoqItemsValidationError('Each section update requires at least one item.')
    group.items.forEach(validateUpdate)
    return { sectionIndex: group.sectionIndex, items: group.items as BoqItemUpdate[] }
  })
}

function updateOneItem(item: BoqItem, update: BoqItemUpdate): BoqItem {
  if (!isPricedBoqItem(item)) {
    const hasNumericEdit = update.unit !== undefined || update.qty !== undefined || update.rate !== undefined
      || update.total !== undefined || update.type !== undefined || update.materialCost !== undefined
      || update.labourCost !== undefined
    if (hasNumericEdit) throw new BoqItemsValidationError('Informational bundle children are read-only numeric rows.')
    return {
      ...item,
      ...(update.code !== undefined ? { code: update.code.trim() } : {}),
      ...(update.desc !== undefined ? { desc: update.desc.trim() } : {}),
    }
  }
  let next: BoqPricedItem = {
    ...item,
    ...(update.code !== undefined ? { code: update.code.trim() } : {}),
    ...(update.desc !== undefined ? { desc: update.desc.trim() } : {}),
    ...(update.unit !== undefined ? { unit: update.unit.trim() } : {}),
    ...(update.qty !== undefined ? { qty: update.qty } : {}),
    ...(update.rate !== undefined ? { rate: update.rate } : {}),
    ...(update.type !== undefined ? { type: update.type } : {}),
    ...(update.excludedFromTotal !== undefined ? { excludedFromTotal: update.excludedFromTotal } : {}),
    ...(update.stdStatus !== undefined ? { stdStatus: update.stdStatus === 'fuzzy' || update.stdStatus === 'llm' ? 'pending' as const : update.stdStatus } : {}),
    ...(update.stdMatch !== undefined ? { stdMatch: update.stdMatch.trim() } : {}),
    ...(update.stdExclusionReason !== undefined ? { stdExclusionReason: update.stdExclusionReason.trim() } : {}),
  }
  if (update.excludedFromTotal !== undefined && item.optional !== true) {
    throw new BoqItemsValidationError('Only optional items can change excludedFromTotal.')
  }
  const hasComponentEdit = update.materialCost !== undefined || update.labourCost !== undefined
  if (hasComponentEdit) {
    const baseline = deriveSourceCostAllocation(next)
    const material = update.materialCost ?? baseline?.material ?? 0
    const labour = update.labourCost ?? baseline?.labour ?? 0
    next = applyManualCostAllocation(next, material, labour)
    if (!costAllocationReconciles(next)) {
      throw new BoqItemsValidationError('Material and Labour components do not reconcile with the row rate and total.')
    }
  }
  if (update.stdMatch === undefined && 'stdMatch' in update) delete next.stdMatch
  if (update.stdStatus === 'excluded') {
    delete next.stdId
    delete next.stdMatch
    delete next.stdConfidence
  } else if (update.stdStatus !== undefined) {
    delete next.stdExclusionReason
  }
  if (!hasComponentEdit) {
    if (update.qty !== undefined || update.rate !== undefined) next.total = next.qty * next.rate
    else if (update.total !== undefined) next.total = update.total
  }
  return next
}

export function applyBoqItemUpdates(
  boqs: Boq[],
  standards: StandardEntry[],
  boqId: string,
  updateGroups: BoqItemUpdateGroup[],
): { boqs: Boq[]; standards: StandardEntry[]; affectedItems: number; affectedBoqs: number; affectedLinkCount: number } {
  const target = boqs.find((boq) => boq.id === boqId)
  if (!target) throw new BoqItemsValidationError('BOQ not found', 404)
  if (target.status === 'approved') throw new BoqItemsValidationError('Approved BOQs cannot be edited.', 409)
  if (updateGroups.length === 0) throw new BoqItemsValidationError('At least one item update is required.')

  const updates = new Map<string, BoqItemUpdate>()
  const standardChanges = new Map<string, { description?: string; unit?: string }>()
  const standardsById = new Map(standards.map((standard) => [standard.id, normalizeStandard(standard)]))

  for (const group of updateGroups) {
    if (!Number.isInteger(group.sectionIndex) || group.sectionIndex < 0 || group.sectionIndex >= target.sections.length) {
      throw new BoqItemsValidationError('Invalid sectionIndex.')
    }
    if (!Array.isArray(group.items) || group.items.length === 0) {
      throw new BoqItemsValidationError('Each section update requires at least one item.')
    }
    for (const update of group.items) {
      const identity = validateUpdate(update)
      const resolution = resolveBoqItemIdentity(target.sections[group.sectionIndex].items, identity)
      const label = identity.itemId ?? identity.itemCode ?? 'unknown'
      if (resolution.status === 'ambiguous') throw new BoqItemsValidationError(`BOQ item identity is ambiguous: ${label}`)
      if (resolution.status !== 'found') throw new BoqItemsValidationError(`BOQ item not found: ${label}`)
      const key = `${group.sectionIndex}:${resolution.index}`
      if (updates.has(key)) throw new BoqItemsValidationError(`Duplicate item update: ${label}`)
      updates.set(key, update)

      const current = target.sections[group.sectionIndex].items[resolution.index]!
      if (!isPricedBoqItem(current)) continue
      const canonicalChanged = (update.desc !== undefined && update.desc.trim() !== current.desc)
        || (update.unit !== undefined && update.unit.trim() !== current.unit)
      if (!canonicalChanged || !current.stdId) continue
      const standard = standardsById.get(current.stdId)
      if (!standard) throw new BoqItemsValidationError(`Linked standard not found: ${current.stdId}`, 404)
      if (standard.archivedAt) throw new BoqItemsValidationError('The linked standard is archived.')
      const change = standardChanges.get(current.stdId) ?? {}
      if (update.desc !== undefined) {
        const description = update.desc.trim()
        if (change.description !== undefined && change.description !== description) {
          throw new BoqItemsValidationError('Conflicting description edits for the same standard.')
        }
        change.description = description
      }
      if (update.unit !== undefined) {
        const unit = update.unit.trim()
        if (change.unit !== undefined && change.unit !== unit) {
          throw new BoqItemsValidationError('Conflicting unit edits for the same standard.')
        }
        change.unit = unit
      }
      standardChanges.set(current.stdId, change)
    }
  }

  const changedStandards = new Map<string, StandardEntry>()
  for (const [standardId, change] of standardChanges) {
    const current = standardsById.get(standardId)!
    changedStandards.set(standardId, {
      ...current,
      description: change.description ?? current.description,
      unit: change.unit ?? current.unit,
    })
  }
  const linkToStandard = new Map<string, string>()
  for (const [standardId, changed] of changedStandards) {
    for (const key of collectStandardLinks(boqs, changed, standardsById.get(standardId)!).keys()) {
      linkToStandard.set(key, standardId)
    }
  }
  for (const candidate of boqs) {
    if (candidate.status !== 'approved') continue
    const wouldChange = candidate.sections.some((section, sectionIndex) => section.items.some((item) => {
      if (item.stdId && changedStandards.has(item.stdId)) return true
      const identityKey = getBoqItemIdentityKey(item)
      return identityKey ? linkToStandard.has(makeLinkKey(candidate.id, sectionIndex, identityKey)) : false
    }))
    if (wouldChange) throw new BoqItemsValidationError('Approved BOQs cannot be edited.', 409)
  }
  const affectedLinkCount = [...standardChanges.keys()].reduce((sum, id) => {
    const standard = standardsById.get(id)
    return sum + (standard ? countBoqStandardLinks(boqs, standard).affectedLinkCount : 0)
  }, 0)

  let affectedItems = 0
  const affectedBoqIds = new Set<string>()
  const updatedBoqs = boqs.map((boq) => {
    let boqChanged = false
    const sections = boq.sections.map((section, sectionIndex) => {
      let sectionChanged = false
      const items = section.items.map((item, itemIndex) => {
        const directUpdate = boq.id === boqId ? updates.get(`${sectionIndex}:${itemIndex}`) : undefined
        const identityKey = getBoqItemIdentityKey(item)
        const linkKey = identityKey ? makeLinkKey(boq.id, sectionIndex, identityKey) : undefined
        const standardId = item.stdId && changedStandards.has(item.stdId)
          ? item.stdId
          : linkKey ? linkToStandard.get(linkKey) : undefined
        const standard = standardId ? changedStandards.get(standardId) : undefined
        if (!directUpdate && !standard) return item
        boqChanged = true
        sectionChanged = true
        affectedBoqIds.add(boq.id)
        let next = directUpdate
          ? updateOneItem(
              isPricedBoqItem(item) && item.sourceDesc === undefined && item.stdId
                ? { ...item, sourceDesc: item.desc, sourceUnit: item.sourceUnit ?? item.unit }
                : item,
              directUpdate,
            )
          : item
        if (standard) {
          next = applyStandardToBoqItem(next, standard, next.stdConfidence ?? 'manual')
          affectedItems += 1
        }
        return next
      })
      return sectionChanged ? { ...section, items } : section
    })
    if (!boqChanged) return boq
    return { ...boq, sections, ...computeTotals(sections), stdStatus: computeStdStatus(sections) }
  })

  return {
    boqs: updatedBoqs,
    standards: standards.map((standard) => changedStandards.get(standard.id) ?? normalizeStandard(standard)),
    affectedItems,
    affectedBoqs: affectedBoqIds.size,
    affectedLinkCount,
  }
}
