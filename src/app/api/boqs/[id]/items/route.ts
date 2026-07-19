import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { runTransaction } from '@/lib/db'
import type { Boq, BoqItem, BoqPricedItem } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import {
  getBoqItemIdentityKey,
  resolveBoqItemIdentity,
  type BoqItemRequestIdentity,
} from '@/lib/boq-item-identity'
import { applyStandardToBoqItem, normalizeStandardEntry } from '../../../standards/route'
import { computeBoqStdStatus } from '../../../standards/[id]/route'
import { deleteBoqItemAndPruneStandards } from '@/lib/boq-deletion'
import { applyManualCostAllocation } from '@/lib/boq-cost-allocation'
import { calculateBoqTotals, isPricedBoqItem } from '@/lib/boq-pricing'

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
}

export interface BoqItemUpdateGroup {
  sectionIndex: number
  items: BoqItemUpdate[]
}

class BoqItemsValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'BoqItemsValidationError'
  }
}

const ALLOWED_STD_STATUSES = new Set(['matched', 'unmatched', 'pending', 'excluded', 'fuzzy', 'llm'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function computeTotals(sections: Boq['sections']) {
  return calculateBoqTotals(sections)
}

function normalizeLinkValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function makeLinkKey(boqId: string, sectionIndex: number, identityKey: string): string {
  return JSON.stringify([boqId, sectionIndex, identityKey])
}

function collectStandardLinkKeys(
  boqs: Boq[],
  standard: StandardEntry,
  previousStandard: StandardEntry = standard,
): Map<string, string> {
  const sourceKeys = new Set(
    [standard.sourceItems, previousStandard.sourceItems]
      .flatMap((sourceItems) => Array.isArray(sourceItems) ? sourceItems : [])
      .filter((source) =>
        isRecord(source) &&
        typeof source.boqId === 'string' &&
        Number.isInteger(source.sectionIndex) &&
        (typeof source.itemId === 'string' || typeof source.itemCode === 'string'),
      )
      .map((source) => {
        const identityKey = typeof source.itemId === 'string' && source.itemId.trim()
          ? `id:${source.itemId.trim()}`
          : `code:${String(source.itemCode).trim()}`
        return makeLinkKey(String(source.boqId), Number(source.sectionIndex), identityKey)
      }),
  )
  const canonicalValues = new Set([
    `${normalizeLinkValue(standard.description)}:${normalizeLinkValue(standard.unit)}`,
    `${normalizeLinkValue(previousStandard.description)}:${normalizeLinkValue(previousStandard.unit)}`,
  ])
  const linkKeys = new Map<string, string>()

  for (const boq of boqs) {
    boq.sections.forEach((section, sectionIndex) => {
      section.items.forEach((item) => {
        if (!isPricedBoqItem(item)) return
        const identityKey = getBoqItemIdentityKey(item)
        if (!identityKey) return
        const key = makeLinkKey(boq.id, sectionIndex, identityKey)
        const hasLegacyProvenance = sourceKeys.has(key) && (!item.stdId || item.stdId === standard.id)
        const hasLegacyCanonicalMatch = !item.stdId && canonicalValues.has(`${normalizeLinkValue(item.desc)}:${normalizeLinkValue(item.unit)}`)
        if (item.stdId === standard.id || hasLegacyProvenance || hasLegacyCanonicalMatch) {
          linkKeys.set(key, boq.id)
        }
      })
    })
  }

  return linkKeys
}

export function countBoqStandardLinks(
  boqs: Boq[],
  standard: StandardEntry,
): { affectedLinkCount: number; affectedBoqCount: number } {
  const linkKeys = collectStandardLinkKeys(boqs, standard)
  const boqIds = new Set(linkKeys.values())

  return { affectedLinkCount: linkKeys.size, affectedBoqCount: boqIds.size }
}

function cloneItemWithUpdate(item: BoqItem, update: BoqItemUpdate): BoqItem {
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
    ...(update.stdStatus !== undefined ? { stdStatus: update.stdStatus === 'fuzzy' || update.stdStatus === 'llm' ? 'pending' as const : update.stdStatus } : {}),
    ...(update.stdMatch !== undefined ? { stdMatch: update.stdMatch.trim() } : {}),
    ...(update.stdExclusionReason !== undefined ? { stdExclusionReason: update.stdExclusionReason.trim() } : {}),
  }

  if (update.materialCost !== undefined || update.labourCost !== undefined) {
    const current = item.costAllocation
    const material = update.materialCost ?? current?.material ?? 0
    const labour = update.labourCost ?? current?.labour ?? 0
    next = applyManualCostAllocation(next, material, labour)
  }

  if (update.stdMatch === undefined && 'stdMatch' in update) {
    delete next.stdMatch
  }
  if (update.stdStatus === 'excluded') {
    delete next.stdId
    delete next.stdMatch
    delete next.stdConfidence
  } else if (update.stdStatus !== undefined) {
    delete next.stdExclusionReason
  }

  if (update.qty !== undefined || update.rate !== undefined) {
    next.total = next.qty * next.rate
  } else if (update.total !== undefined) {
    next.total = update.total
  }

  return next
}

function validateUpdate(value: unknown): BoqItemRequestIdentity {
  if (!isRecord(value)) {
    throw new BoqItemsValidationError('Each item update must be an object.')
  }
  const update = value as BoqItemUpdate
  if ('itemId' in value && typeof value.itemId !== 'string') {
    throw new BoqItemsValidationError('itemId must be a string.')
  }
  if ('itemCode' in value && typeof value.itemCode !== 'string') {
    throw new BoqItemsValidationError('itemCode must be a string.')
  }
  if ('code' in value && typeof value.code !== 'string') {
    throw new BoqItemsValidationError('code must be a string.')
  }
  if ('stdStatus' in value && (typeof value.stdStatus !== 'string' || !ALLOWED_STD_STATUSES.has(value.stdStatus))) {
    throw new BoqItemsValidationError('stdStatus is invalid.')
  }
  if ('stdMatch' in value && typeof value.stdMatch !== 'string') {
    throw new BoqItemsValidationError('stdMatch must be a string.')
  }
  if ('stdExclusionReason' in value && typeof value.stdExclusionReason !== 'string') {
    throw new BoqItemsValidationError('stdExclusionReason must be a string.')
  }
  if (update.stdStatus === 'excluded' && !update.stdExclusionReason?.trim()) {
    throw new BoqItemsValidationError('An exclusion reason is required.')
  }

  const itemId = update.itemId?.trim()
  const itemCode = (update.itemCode ?? update.code)?.trim()
  if ((!itemId && !itemCode) || (itemId?.length ?? 0) > 200 || (itemCode?.length ?? 0) > 200) {
    throw new BoqItemsValidationError('Each item update requires a non-empty itemId or itemCode identity.')
  }
  if (update.code !== undefined && (typeof update.code !== 'string' || !update.code.trim() || update.code.trim().length > 200)) {
    throw new BoqItemsValidationError('code must be a non-empty string.')
  }
  if (update.desc !== undefined && (typeof update.desc !== 'string' || !update.desc.trim())) {
    throw new BoqItemsValidationError('Description cannot be empty.')
  }
  if (update.unit !== undefined && (typeof update.unit !== 'string' || !update.unit.trim())) {
    throw new BoqItemsValidationError('Unit cannot be empty.')
  }
  for (const [field, value] of [['qty', update.qty], ['rate', update.rate], ['total', update.total], ['materialCost', update.materialCost], ['labourCost', update.labourCost]] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new BoqItemsValidationError(`${field} must be a finite non-negative number.`)
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

export function applyBoqItemUpdates(
  boqs: Boq[],
  standards: StandardEntry[],
  boqId: string,
  updateGroups: BoqItemUpdateGroup[],
): { boqs: Boq[]; standards: StandardEntry[]; affectedItems: number; affectedBoqs: number; affectedLinkCount: number } {
  const target = boqs.find((boq) => boq.id === boqId)
  if (!target) throw new BoqItemsValidationError('BOQ not found', 404)
  if (updateGroups.length === 0) throw new BoqItemsValidationError('At least one item update is required.')

  const targetUpdates = new Map<string, { sectionIndex: number; itemIndex: number; item: BoqItem; update: BoqItemUpdate }>()
  const standardChanges = new Map<string, { description?: string; unit?: string }>()
  const standardById = new Map(standards.map((entry) => [entry.id, normalizeStandardEntry(entry)]))

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
      const identityLabel = identity.itemId ?? identity.itemCode ?? 'unknown'
      if (resolution.status === 'ambiguous') throw new BoqItemsValidationError(`BOQ item identity is ambiguous: ${identityLabel}`)
      if (resolution.status !== 'found') throw new BoqItemsValidationError(`BOQ item not found: ${identityLabel}`)
      const itemIndex = resolution.index
      const key = `${group.sectionIndex}:${itemIndex}`
      if (targetUpdates.has(key)) throw new BoqItemsValidationError(`Duplicate item update: ${identityLabel}`)

      const currentItem = target.sections[group.sectionIndex].items[itemIndex]
      targetUpdates.set(key, { sectionIndex: group.sectionIndex, itemIndex, item: currentItem, update })

      if (!isPricedBoqItem(currentItem)) continue

      const canonicalChanged =
        (update.desc !== undefined && update.desc.trim() !== currentItem.desc) ||
        (update.unit !== undefined && update.unit.trim() !== currentItem.unit)
      if (!canonicalChanged || !currentItem.stdId) continue

      const standard = standardById.get(currentItem.stdId)
      if (!standard) throw new BoqItemsValidationError(`Linked standard not found: ${currentItem.stdId}`, 404)
      if (standard.archivedAt) throw new BoqItemsValidationError('The linked standard is archived.')

      const previous = standardChanges.get(currentItem.stdId) ?? {}
      if (update.desc !== undefined) {
        const description = update.desc.trim()
        if (previous.description !== undefined && previous.description !== description) {
          throw new BoqItemsValidationError('Conflicting description edits for the same standard.')
        }
        previous.description = description
      }
      if (update.unit !== undefined) {
        const unit = update.unit.trim()
        if (previous.unit !== undefined && previous.unit !== unit) {
          throw new BoqItemsValidationError('Conflicting unit edits for the same standard.')
        }
        previous.unit = unit
      }
      standardChanges.set(currentItem.stdId, previous)
    }
  }

  const changedStandards = new Map<string, StandardEntry>()
  for (const [standardId, change] of standardChanges) {
    const existing = standardById.get(standardId)!
    changedStandards.set(standardId, {
      ...existing,
      description: change.description ?? existing.description,
      unit: change.unit ?? existing.unit,
    })
  }
  const linkKeyToStandardId = new Map<string, string>()
  for (const [standardId, changedStandard] of changedStandards) {
    const previousStandard = standardById.get(standardId)
    if (!previousStandard) continue
    for (const linkKey of collectStandardLinkKeys(boqs, changedStandard, previousStandard).keys()) {
      linkKeyToStandardId.set(linkKey, standardId)
    }
  }
  const affectedLinkCount = Array.from(standardChanges.keys()).reduce((sum, standardId) => {
    const standard = standardById.get(standardId)
    return sum + (standard ? countBoqStandardLinks(boqs, standard).affectedLinkCount : 0)
  }, 0)

  let affectedItems = 0
  const affectedBoqIds = new Set<string>()
  const updatedBoqs = boqs.map((boq) => {
    let changed = false
    const sections = boq.sections.map((section, sectionIndex) => {
      let sectionChanged = false
      const items = section.items.map((item, itemIndex) => {
        const targetUpdate = boq.id === boqId ? targetUpdates.get(`${sectionIndex}:${itemIndex}`) : undefined
        const identityKey = getBoqItemIdentityKey(item)
        const linkKey = identityKey ? makeLinkKey(boq.id, sectionIndex, identityKey) : undefined
        const linkedStandardId = item.stdId && changedStandards.has(item.stdId)
          ? item.stdId
          : linkKey ? linkKeyToStandardId.get(linkKey) : undefined
        const standard = linkedStandardId ? changedStandards.get(linkedStandardId) : undefined
        if (!targetUpdate && !standard) return item

        changed = true
        sectionChanged = true
        affectedBoqIds.add(boq.id)
        let next = item
        if (targetUpdate) {
          next = cloneItemWithUpdate(
            isPricedBoqItem(item) && item.sourceDesc === undefined && item.stdId ? { ...item, sourceDesc: item.desc, sourceUnit: item.sourceUnit ?? item.unit } : item,
            targetUpdate.update,
          )
        }
        if (standard) {
          next = applyStandardToBoqItem(next, standard, next.stdConfidence ?? 'manual')
          affectedItems += 1
        }
        return next
      })

      return sectionChanged ? { ...section, items } : section
    })

    if (!changed) return boq
    const totals = computeTotals(sections)
    return { ...boq, sections, ...totals, stdStatus: computeBoqStdStatus(sections) }
  })

  return {
    boqs: updatedBoqs,
    standards: standards.map((standard) => changedStandards.get(standard.id) ?? normalizeStandardEntry(standard)),
    affectedItems,
    affectedBoqs: affectedBoqIds.size,
    affectedLinkCount,
  }
}

export function parseUpdateGroups(body: unknown): BoqItemUpdateGroup[] {
  if (!isRecord(body)) {
    throw new BoqItemsValidationError('Request body must be an object.')
  }
  const hasBatch = 'updates' in body
  if (hasBatch && !Array.isArray(body.updates)) {
    throw new BoqItemsValidationError('updates must be an array.')
  }
  if (!hasBatch && !Array.isArray(body.items)) {
    throw new BoqItemsValidationError('items must be an array.')
  }
  const groups: unknown[] = hasBatch
    ? body.updates as unknown[]
    : [{ sectionIndex: body.sectionIndex, items: body.items }]
  if (groups.length === 0) {
    throw new BoqItemsValidationError('At least one section update is required.')
  }

  return groups.map((group) => {
    if (!isRecord(group)) {
      throw new BoqItemsValidationError('Invalid section update.')
    }
    const sectionIndex = group.sectionIndex
    if (typeof sectionIndex !== 'number' || !Number.isInteger(sectionIndex) || sectionIndex < 0 || !Array.isArray(group.items)) {
      throw new BoqItemsValidationError('sectionIndex and items are required.')
    }
    if (group.items.length === 0) {
      throw new BoqItemsValidationError('Each section update requires at least one item.')
    }
    for (const item of group.items) validateUpdate(item)
    return { sectionIndex, items: group.items as BoqItemUpdate[] }
  })
}

export async function GET(
  request: NextRequest,
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const standardId = new URL(request.url).searchParams.get('stdId')?.trim()
  if (!standardId) {
    return NextResponse.json({ error: 'stdId is required' }, { status: 400 })
  }

  try {
    const result = await runTransaction(async (transaction, db) => {
      const [boqsSnap, standardsSnap] = await Promise.all([
        transaction.get(db.collection('boqs')),
        transaction.get(db.collection('standards')),
      ])
      const standardDoc = standardsSnap.docs.find((doc) => doc.id === standardId)
      if (!standardDoc) throw new BoqItemsValidationError('Standard not found', 404)
      const standard = normalizeStandardEntry({ id: standardDoc.id, ...standardDoc.data() } as StandardEntry)
      const boqs = boqsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)
      return { standard, ...countBoqStandardLinks(boqs, standard) }
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof BoqItemsValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error counting BOQ standard links:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
    }
    const groups = parseUpdateGroups(body)
    const result = await runTransaction(async (transaction, db) => {
      const [boqsSnap, standardsSnap] = await Promise.all([
        transaction.get(db.collection('boqs')),
        transaction.get(db.collection('standards')),
      ])
      const boqs = boqsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)
      const standards = standardsSnap.docs.map((doc) => normalizeStandardEntry({ id: doc.id, ...doc.data() } as StandardEntry))
      const applied = applyBoqItemUpdates(boqs, standards, id, groups)
      const now = new Date().toISOString()

      for (const standard of applied.standards) {
        const previous = standards.find((candidate) => candidate.id === standard.id)
        if (!previous || previous.description === standard.description && previous.unit === standard.unit) continue
        transaction.update(db.collection('standards').doc(standard.id), {
          description: standard.description,
          unit: standard.unit,
          updatedAt: now,
        })
      }

      for (const updatedBoq of applied.boqs) {
        const original = boqs.find((candidate) => candidate.id === updatedBoq.id)
        if (!original || original === updatedBoq) continue
        transaction.update(db.collection('boqs').doc(updatedBoq.id), {
          sections: updatedBoq.sections,
          totalItems: updatedBoq.totalItems,
          grandTotal: updatedBoq.grandTotal,
          stdStatus: updatedBoq.stdStatus,
          updatedAt: now,
        })
      }

      const updatedBoq = applied.boqs.find((boq) => boq.id === id)
      return { ...applied, boq: updatedBoq }
    })

    return NextResponse.json({
      ...result.boq,
      sync: {
        affectedItems: result.affectedItems,
        affectedBoqs: result.affectedBoqs,
        affectedLinkCount: result.affectedLinkCount,
      },
    })
  } catch (error) {
    if (error instanceof BoqItemsValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error updating BOQ items:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
    }
    if (!isRecord(body) || !Number.isInteger(body.sectionIndex) || Number(body.sectionIndex) < 0) {
      return NextResponse.json({ error: 'sectionIndex is required.' }, { status: 400 })
    }
    const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : ''
    const itemCode = typeof body.itemCode === 'string' ? body.itemCode.trim() : ''
    if (!itemId && !itemCode) {
      return NextResponse.json({ error: 'itemId or itemCode is required.' }, { status: 400 })
    }

    const result = await runTransaction(async (transaction, db) => {
      const [boqSnap, standardsSnap] = await Promise.all([
        transaction.get(db.collection('boqs').doc(id)),
        transaction.get(db.collection('standards')),
      ])
      if (!boqSnap.exists) throw new BoqItemsValidationError('BOQ not found', 404)
      const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
      const standards = standardsSnap.docs.map((doc) => normalizeStandardEntry({ id: doc.id, ...doc.data() } as StandardEntry))
      let applied: ReturnType<typeof deleteBoqItemAndPruneStandards>
      try {
        applied = deleteBoqItemAndPruneStandards(
          boq,
          standards,
          Number(body.sectionIndex),
          itemId ? { itemId } : { itemCode },
        )
      } catch (error) {
        throw new BoqItemsValidationError(error instanceof Error ? error.message : 'Unable to delete BOQ item.')
      }
      const now = new Date().toISOString()
      transaction.update(boqSnap.ref, {
        sections: applied.boq.sections,
        totalItems: applied.boq.totalItems,
        grandTotal: applied.boq.grandTotal,
        stdStatus: applied.boq.stdStatus,
        updatedAt: now,
      })
      applied.standards.forEach((standard, index) => {
        const previous = standards[index]
        if (JSON.stringify(previous.sourceItems ?? []) === JSON.stringify(standard.sourceItems ?? [])) return
        transaction.update(db.collection('standards').doc(standard.id), {
          sourceItems: standard.sourceItems ?? [],
          sourceBoqCount: standard.sourceBoqCount,
          updatedAt: now,
        })
      })
      return applied.boq
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof BoqItemsValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error deleting BOQ item:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
