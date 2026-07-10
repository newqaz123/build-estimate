import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument, updateDocument, deleteDocument } from '@/lib/db'
import type { StandardEntry } from '@/lib/standard-schema'

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
    const existing = await getDocument<StandardEntry>('standards', id)
    if (!existing) {
      return NextResponse.json({ error: 'Standard not found' }, { status: 404 })
    }

    const body = await request.json()
    const { description, unit, category, aliases } = body as {
      description?: string
      unit?: string
      category?: string
      aliases?: string[]
    }

    const updates: Record<string, unknown> = {}
    if (description !== undefined) updates.description = description
    if (unit !== undefined) updates.unit = unit
    if (category !== undefined) updates.category = category
    if (aliases !== undefined) updates.aliases = aliases

    await updateDocument('standards', id, updates)

    const updated = await getDocument<StandardEntry>('standards', id)
    return NextResponse.json(updated)
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
    const existing = await getDocument<StandardEntry>('standards', id)
    if (!existing) {
      return NextResponse.json({ error: 'Standard not found' }, { status: 404 })
    }

    await deleteDocument('standards', id)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting standard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
