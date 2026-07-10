import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument, updateDocument, deleteDocument } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'

function computeTotals(sections: Boq['sections']) {
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0)
  const grandTotal = sections.reduce((sum, s) => sum + s.items.reduce((s2, i) => s2 + i.total, 0), 0)
  return { totalItems, grandTotal }
}

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
    const boq = await getDocument<Boq>('boqs', id)
    if (!boq) {
      return NextResponse.json({ error: 'BOQ not found' }, { status: 404 })
    }
    return NextResponse.json(boq)
  } catch (error) {
    console.error('Error fetching BOQ:', error)
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
    const existing = await getDocument<Boq>('boqs', id)
    if (!existing) {
      return NextResponse.json({ error: 'BOQ not found' }, { status: 404 })
    }

    const body = await request.json()
    const updates: Record<string, unknown> = {}

    if (body.project !== undefined) updates.project = body.project
    if (body.vendor !== undefined) updates.vendor = body.vendor
    if (body.vendorId !== undefined) updates.vendorId = body.vendorId
    if (body.workType !== undefined) {
      if (!['Structural', 'MEP', 'Finishing'].includes(body.workType)) {
        return NextResponse.json({ error: 'workType must be Structural, MEP, or Finishing' }, { status: 400 })
      }
      updates.workType = body.workType
    }
    if (body.date !== undefined) updates.date = body.date
    if (body.status !== undefined) {
      const validStatuses = ['draft', 'parsed', 'active', 'review', 'approved', 'rejected']
      if (!validStatuses.includes(body.status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
      }
      updates.status = body.status
    }
    if (body.sections !== undefined) {
      updates.sections = body.sections
      const { totalItems, grandTotal } = computeTotals(body.sections)
      updates.totalItems = totalItems
      updates.grandTotal = grandTotal
    }

    await updateDocument('boqs', id, updates)
    const updated = await getDocument<Boq>('boqs', id)
    return NextResponse.json(updated)
  } catch (error) {
    console.error('Error updating BOQ:', error)
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
    const existing = await getDocument<Boq>('boqs', id)
    if (!existing) {
      return NextResponse.json({ error: 'BOQ not found' }, { status: 404 })
    }

    await deleteDocument('boqs', id)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting BOQ:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
