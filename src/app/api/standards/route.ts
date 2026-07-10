import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import type { StandardEntry } from '@/lib/standard-schema'

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getDb()
    const snapshot = await db.collection('standards').orderBy('description', 'asc').get()
    const standards: StandardEntry[] = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as StandardEntry[]

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

    const now = new Date().toISOString()
    const id = crypto.randomUUID()

    const entry: StandardEntry = {
      id,
      description,
      unit,
      category: category || '',
      aliases: aliases || [],
      sourceBoqCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    const db = getDb()
    await db.collection('standards').doc(id).set(entry)

    return NextResponse.json(entry, { status: 201 })
  } catch (error) {
    console.error('Error creating standard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
