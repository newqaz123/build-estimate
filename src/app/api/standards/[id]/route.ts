import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { runTransaction } from '@/lib/db'
import type { Boq, BoqItem } from '@/lib/boq-schema'
import type { Estimate } from '@/lib/estimate-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { applyStandardToBoqItem, normalizeStandardEntry } from '../route'
import { isPricedBoqItem } from '@/lib/boq-pricing'

function normalizeText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

export function computeBoqStdStatus(sections: Boq['sections']): Boq['stdStatus'] {
  const items = sections.flatMap((section) => section.items).filter(isPricedBoqItem).filter((item) => item.rate > 0)
  const matchedCount = items.filter((item) => item.stdStatus === 'matched' || (item.stdStatus === 'excluded' && item.stdExclusionReason?.trim())).length

  if (matchedCount === 0) return 'none'
  if (matchedCount === items.length && items.length > 0) return 'complete'
  return 'partial'
}

export function itemMatchesStandardCanonically(item: BoqItem, standard: StandardEntry): boolean {
  return isPricedBoqItem(item) && normalizeText(item.desc) === normalizeText(standard.description) && normalizeText(item.unit) === normalizeText(standard.unit)
}

export function hasLinkedEstimateItems(estimates: Estimate[], standardId: string): boolean {
  return estimates.some((estimate) => estimate.items.some((item) => item.stdId === standardId))
}

function itemLinksToStandard(item: BoqItem, standard: StandardEntry, previousStandard?: StandardEntry): boolean {
  return (
    item.stdId === standard.id ||
    itemMatchesStandardCanonically(item, standard) ||
    (previousStandard ? itemMatchesStandardCanonically(item, previousStandard) : false)
  )
}

export function updateLinkedBoqsForStandard(
  boqs: Boq[],
  standard: StandardEntry,
  previousStandard?: StandardEntry,
): { boqs: Boq[]; affectedItems: number } {
  let affectedItems = 0

  const updatedBoqs = boqs.map((boq) => {
    let changed = false
    const sections = boq.sections.map((section) => {
      let sectionChanged = false
      const items = section.items.map((item) => {
        if (!itemLinksToStandard(item, standard, previousStandard)) {
          return item
        }

        changed = true
        sectionChanged = true
        affectedItems += 1
        return applyStandardToBoqItem(item, standard, item.stdConfidence ?? 'manual')
      })

      return sectionChanged ? { ...section, items } : section
    })

    if (!changed) return boq

    return {
      ...boq,
      sections,
      stdStatus: computeBoqStdStatus(sections),
    }
  })

  return { boqs: updatedBoqs, affectedItems }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const body = await request.json()
    const { description, unit, category, aliases } = body as {
      description?: string
      unit?: string
      category?: string
      aliases?: string[]
    }
    if (description !== undefined && !description.trim()) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 })
    }
    if (unit !== undefined && !unit.trim()) {
      return NextResponse.json({ error: 'Unit is required' }, { status: 400 })
    }
    if (aliases !== undefined && !Array.isArray(aliases)) {
      return NextResponse.json({ error: 'Aliases must be an array' }, { status: 400 })
    }

    const updatedAt = new Date().toISOString()
    const result = await runTransaction(async (transaction, db) => {
      const standardRef = db.collection('standards').doc(id)
      const standardsSnap = await transaction.get(standardRef)
      if (!standardsSnap.exists) {
        return { error: 'Standard not found' as const }
      }

      const existing = normalizeStandardEntry({ id: standardsSnap.id, ...standardsSnap.data() } as StandardEntry)
      const updatedStandard: StandardEntry = {
        ...existing,
        description: description?.trim() ?? existing.description,
        unit: unit?.trim() ?? existing.unit,
        category: category !== undefined ? category.trim() : existing.category,
        aliases: aliases !== undefined
          ? aliases.filter((alias) => typeof alias === 'string').map((alias) => alias.trim()).filter(Boolean)
          : existing.aliases,
        updatedAt,
      }

      const boqsQuery = db.collection('boqs')
      const boqsSnap = await transaction.get(boqsQuery)
      const boqs = boqsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)
      const { boqs: updatedBoqs, affectedItems } = updateLinkedBoqsForStandard(boqs, updatedStandard, existing)

      transaction.update(standardRef, {
        description: updatedStandard.description,
        unit: updatedStandard.unit,
        category: updatedStandard.category ?? '',
        aliases: updatedStandard.aliases,
        updatedAt,
      })

      for (const boq of updatedBoqs) {
        const original = boqs.find((candidate) => candidate.id === boq.id)
        if (original !== boq && original?.sections !== boq.sections) {
          transaction.update(db.collection('boqs').doc(boq.id), {
            sections: boq.sections,
            stdStatus: boq.stdStatus,
            updatedAt,
          })
        }
      }

      return { standard: updatedStandard, affectedItems }
    })

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 404 })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Error updating standard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const updatedAt = new Date().toISOString()
    const result = await runTransaction(async (transaction, db) => {
      const standardRef = db.collection('standards').doc(id)
      const standardSnap = await transaction.get(standardRef)
      if (!standardSnap.exists) {
        return { error: 'Standard not found' as const, status: 404 }
      }

      const standard = normalizeStandardEntry({ id: standardSnap.id, ...standardSnap.data() } as StandardEntry)
      const boqsSnap = await transaction.get(db.collection('boqs'))
      const hasLinkedBoqItems = boqsSnap.docs.some((doc) => {
        const boq = { id: doc.id, ...doc.data() } as Boq
        return boq.sections.some((section) =>
          section.items.some((item) => item.stdId === id || itemMatchesStandardCanonically(item, standard)),
        )
      })

      const estimatesSnap = await transaction.get(db.collection('estimates'))
      const estimates = estimatesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Estimate)
      const hasLinkedEstimateRows = hasLinkedEstimateItems(estimates, id)

      if (hasLinkedBoqItems || hasLinkedEstimateRows) {
        transaction.update(standardRef, { archivedAt: updatedAt, updatedAt })
        return { success: true, archived: true, deleted: false }
      }

      transaction.delete(standardRef)
      return { success: true, archived: false, deleted: true }
    })

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Error deleting standard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
