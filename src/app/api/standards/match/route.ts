import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { runTransaction } from '@/lib/db'
import type { Boq, BoqItem } from '@/lib/boq-schema'
import type { StandardEntry, StandardSourceItem } from '@/lib/standard-schema'
import {
  getBoqItemRequestIdentity,
  parseBoqItemRequestIdentity,
  resolveBoqItemIdentity,
} from '@/lib/boq-item-identity'
import { computeBoqStdStatus } from '../[id]/route'
import { applyStandardToBoqItem, mergeStandardSourceItems, normalizeStandardEntry } from '../route'

type MatchConfidence = NonNullable<BoqItem['stdConfidence']>

type ExistingStandardPayload = {
  boqId: string
  sectionIndex: number
  itemId?: string
  itemCode?: string
  standardId: string
  confidence: MatchConfidence
}

type NewStandardPayload = {
  boqId: string
  sectionIndex: number
  itemId?: string
  itemCode?: string
  newStandard: {
    description: string
    unit: string
    aliases?: string[]
    category?: string
  }
  confidence: 'manual'
}

function isConfidence(value: unknown): value is MatchConfidence {
  return value === 'exact' || value === 'fuzzy' || value === 'llm' || value === 'manual'
}

function isExistingStandardPayload(body: Record<string, unknown>): body is ExistingStandardPayload {
  return typeof body.standardId === 'string'
}

function isNewStandardPayload(body: Record<string, unknown>): body is NewStandardPayload {
  return typeof body.newStandard === 'object' && body.newStandard !== null
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json() as Record<string, unknown>
    const boqId = trimString(body.boqId)
    const itemIdentity = parseBoqItemRequestIdentity(body)
    const sectionIndex = typeof body.sectionIndex === 'number' ? body.sectionIndex : Number.NaN
    const confidence = body.confidence

    if (!boqId || !itemIdentity || !Number.isInteger(sectionIndex) || sectionIndex < 0 || !isConfidence(confidence)) {
      return NextResponse.json({ error: 'boqId, sectionIndex, itemId or itemCode, and confidence are required' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const newStandardId = crypto.randomUUID()
    const result = await runTransaction(async (transaction, db) => {
      const hasExistingStandard = isExistingStandardPayload(body)
      const hasNewStandard = isNewStandardPayload(body)
      if (hasExistingStandard === hasNewStandard) {
        return { error: 'Provide either standardId or newStandard' as const, status: 400 }
      }

      const boqRef = db.collection('boqs').doc(boqId)
      const boqSnap = await transaction.get(boqRef)
      if (!boqSnap.exists) {
        return { error: 'BOQ not found' as const, status: 404 }
      }

      const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
      const section = boq.sections[sectionIndex]
      if (!section) {
        return { error: 'Section not found' as const, status: 400 }
      }

      const resolution = resolveBoqItemIdentity(section.items, itemIdentity)
      if (resolution.status === 'ambiguous') {
        return { error: 'BOQ item identity is ambiguous' as const, status: 400 }
      }
      if (resolution.status !== 'found') {
        return { error: 'BOQ item not found' as const, status: 400 }
      }
      const itemIndex = resolution.index

      const currentItem = section.items[itemIndex]!
      const resolvedIdentity = getBoqItemRequestIdentity(currentItem)
      const sourceItem: StandardSourceItem = {
        boqId,
        sectionIndex,
        ...resolvedIdentity,
        sourceDescription: currentItem.sourceDesc ?? currentItem.desc,
      }

      let standard: StandardEntry | null = null
      let responseStatus = 200

      if (hasExistingStandard) {
        const standardId = trimString(body.standardId)
        if (!standardId) {
          return { error: 'standardId is required' as const, status: 400 }
        }

        const standardRef = db.collection('standards').doc(standardId)
        const standardSnap = await transaction.get(standardRef)
        if (!standardSnap.exists) {
          return { error: 'Standard not found' as const, status: 404 }
        }

        const existing = normalizeStandardEntry({ id: standardSnap.id, ...standardSnap.data() } as StandardEntry)
        if (existing.archivedAt) {
          return { error: 'Standard is archived' as const, status: 400 }
        }

        standard = mergeStandardSourceItems(existing, sourceItem, now)
        transaction.update(standardRef, {
          sourceItems: standard.sourceItems,
          sourceBoqCount: standard.sourceBoqCount,
          lastMatched: standard.lastMatched,
          updatedAt: now,
        })
      } else if (hasNewStandard) {
        const { newStandard } = body
        const description = trimString(newStandard.description)
        const unit = trimString(newStandard.unit)
        if (confidence !== 'manual') {
          return { error: 'New standards require manual confidence' as const, status: 400 }
        }
        if (!description || !unit) {
          return { error: 'newStandard description and unit are required' as const, status: 400 }
        }

        standard = {
          id: newStandardId,
          description,
          unit,
          category: trimString(newStandard.category),
          aliases: Array.isArray(newStandard.aliases)
            ? newStandard.aliases.filter((alias): alias is string => typeof alias === 'string').map((alias) => alias.trim()).filter(Boolean)
            : [],
          sourceItems: [],
          sourceBoqCount: 0,
          createdAt: now,
          updatedAt: now,
        }
        standard = mergeStandardSourceItems(standard, sourceItem, now)
        transaction.set(db.collection('standards').doc(newStandardId), {
          id: standard.id,
          description: standard.description,
          unit: standard.unit,
          category: standard.category ?? '',
          aliases: standard.aliases,
          sourceItems: standard.sourceItems,
          sourceBoqCount: standard.sourceBoqCount,
          lastMatched: standard.lastMatched,
          createdAt: now,
          updatedAt: now,
        })
        responseStatus = 201
      }

      if (!standard) {
        return { error: 'Provide either standardId or newStandard' as const, status: 400 }
      }

      const nextSections = boq.sections.map((candidateSection, candidateSectionIndex) => {
        if (candidateSectionIndex !== sectionIndex) return candidateSection

        return {
          ...candidateSection,
          items: candidateSection.items.map((candidateItem, candidateItemIndex) =>
            candidateItemIndex === itemIndex
              ? applyStandardToBoqItem(candidateItem, standard, confidence)
              : candidateItem,
          ),
        }
      })

      const updatedBoq: Boq = {
        ...boq,
        sections: nextSections,
        stdStatus: computeBoqStdStatus(nextSections),
        updatedAt: now,
      }

      transaction.update(boqRef, {
        sections: updatedBoq.sections,
        stdStatus: updatedBoq.stdStatus,
        updatedAt: now,
      })

      return { standard, boq: updatedBoq, status: responseStatus }
    })

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ standard: result.standard, boq: result.boq }, { status: result.status })
  } catch (error) {
    console.error('Error matching standard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
