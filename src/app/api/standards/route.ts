import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { queryCollection, getDocument, createDocumentWithId } from '@/lib/db'
import type { StandardEntry } from '@/lib/standard-schema'
import type { BoqItem } from '@/lib/boq-schema'

type MatchConfidence = BoqItem['stdConfidence']

export function normalizeStandardEntry(entry: StandardEntry): StandardEntry {
  return {
    ...entry,
    aliases: entry.aliases ?? [],
    sourceItems: entry.sourceItems ?? [],
  }
}

export function queryStandards(
  entries: StandardEntry[],
  { includeArchived = false, search }: { includeArchived?: boolean; search?: string | null } = {},
): StandardEntry[] {
  const normalizedSearch = search?.trim().toLowerCase()

  return entries
    .map(normalizeStandardEntry)
    .filter((entry) => includeArchived || !entry.archivedAt)
    .filter((entry) => {
      if (!normalizedSearch) return true

      return (
        entry.description.toLowerCase().includes(normalizedSearch) ||
        entry.unit.toLowerCase().includes(normalizedSearch) ||
        entry.aliases.some((alias) => alias.toLowerCase().includes(normalizedSearch))
      )
    })
}

export function applyStandardToBoqItem(
  item: BoqItem,
  standard: StandardEntry,
  confidence: MatchConfidence,
): BoqItem {
  return {
    ...item,
    desc: standard.description,
    unit: standard.unit,
    stdId: standard.id,
    stdMatch: standard.description,
    stdStatus: 'matched',
    stdConfidence: confidence,
    sourceDesc: item.sourceDesc ?? item.desc,
    sourceUnit: item.sourceUnit ?? item.unit,
  }
}

export function mergeStandardSourceItems(
  standard: StandardEntry,
  sourceItem: NonNullable<StandardEntry['sourceItems']>[number],
  matchedAt: string,
): StandardEntry {
  const existingItems = standard.sourceItems ?? []
  const alreadyPresent = existingItems.some(
    (entry) =>
      entry.boqId === sourceItem.boqId &&
      entry.sectionIndex === sourceItem.sectionIndex &&
      entry.itemCode === sourceItem.itemCode &&
      entry.sourceDescription === sourceItem.sourceDescription,
  )

  const nextSourceItems = alreadyPresent ? existingItems : [...existingItems, sourceItem]
  const uniqueBoqIds = new Set(nextSourceItems.map((entry) => entry.boqId))

  return {
    ...normalizeStandardEntry(standard),
    sourceItems: nextSourceItems,
    sourceBoqCount: uniqueBoqIds.size,
    lastMatched: matchedAt,
  }
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')
    const includeArchived = searchParams.get('includeArchived') === 'true'

    const { docs } = await queryCollection<StandardEntry>('standards', {
      orderByField: 'description',
      orderDirection: 'asc',
    })

    const standards = queryStandards(docs, { includeArchived, search })

    return NextResponse.json(standards)
  } catch (error) {
    console.error('Error fetching standards:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { description, unit, category, aliases } = body as {
      description: string
      unit: string
      category?: string
      aliases?: string[]
    }

    const trimmedDescription = description?.trim()
    const trimmedUnit = unit?.trim()
    if (!trimmedDescription || !trimmedUnit) {
      return NextResponse.json({ error: 'Description and unit are required' }, { status: 400 })
    }

    const id = crypto.randomUUID()
    const entry: Omit<StandardEntry, 'createdAt' | 'updatedAt'> = {
      id,
      description: trimmedDescription,
      unit: trimmedUnit,
      category: category?.trim() || '',
      aliases: Array.isArray(aliases) ? aliases.filter((alias) => typeof alias === 'string').map((alias) => alias.trim()).filter(Boolean) : [],
      sourceItems: [],
      sourceBoqCount: 0,
    }

    await createDocumentWithId('standards', id, entry as unknown as Record<string, unknown>)
    const created = await getDocument<StandardEntry>('standards', id)

    return NextResponse.json(created ? normalizeStandardEntry(created) : null, { status: 201 })
  } catch (error) {
    console.error('Error creating standard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
