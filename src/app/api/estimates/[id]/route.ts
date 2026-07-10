import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument, updateDocument, deleteDocument } from '@/lib/db'
import type { Estimate, EstimateItem } from '@/lib/estimate-schema'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const estimate = await getDocument<Estimate>('estimates', id)
    if (!estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    return NextResponse.json(estimate)
  } catch (error) {
    console.error('Error fetching estimate:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
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
    const existing = await getDocument<Estimate>('estimates', id)
    if (!existing) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    const body = await request.json()
    const { name, project, date, notes, items, status } = body as {
      name?: string
      project?: string
      date?: string
      notes?: string
      items?: EstimateItem[]
      status?: 'draft' | 'final'
    }

    const updates: Record<string, unknown> = {}
    if (name !== undefined) updates.name = name
    if (project !== undefined) updates.project = project
    if (date !== undefined) updates.date = date
    if (notes !== undefined) updates.notes = notes
    if (items !== undefined) {
      updates.items = items
      updates.totalAmount = items.reduce((sum, item) => sum + (item.total || 0), 0)
    }
    if (status !== undefined) updates.status = status

    await updateDocument('estimates', id, updates)

    const updated = await getDocument<Estimate>('estimates', id)
    return NextResponse.json(updated)
  } catch (error) {
    console.error('Error updating estimate:', error)
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
    const existing = await getDocument<Estimate>('estimates', id)
    if (!existing) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 })
    }

    await deleteDocument('estimates', id)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting estimate:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
