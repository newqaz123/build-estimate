import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { queryCollection, getDocument, createDocumentWithId } from '@/lib/db'
import type { StandardEntry } from '@/lib/standard-schema'

function normalizeStandardEntry(entry: StandardEntry): StandardEntry {
  return {
    ...entry,
    aliases: entry.aliases ?? [],
    sourceItems: entry.sourceItems ?? [],
  }
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.toLowerCase()

    const { docs } = await queryCollection<StandardEntry>('standards', {
      orderByField: 'description',
      orderDirection: 'asc',
    })

    let standards = docs.map(normalizeStandardEntry)
    if (search) {
      standards = standards.filter(
        (s) => s.description.toLowerCase().includes(search) || s.aliases?.some(a => a.toLowerCase().includes(search))
      )
    }

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

    if (!description || !unit) {
      return NextResponse.json({ error: 'Description and unit are required' }, { status: 400 })
    }

    const id = crypto.randomUUID()
    const entry: Omit<StandardEntry, 'createdAt' | 'updatedAt'> = {
      id,
      description,
      unit,
      category: category || '',
      aliases: aliases || [],
      sourceItems: [],
      sourceBoqCount: 0,
    }

    await createDocumentWithId('standards', id, entry as unknown as Record<string, unknown>)
    const created = await getDocument<StandardEntry>('standards', id)

    return NextResponse.json(created, { status: 201 })
  } catch (error) {
    console.error('Error creating standard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
