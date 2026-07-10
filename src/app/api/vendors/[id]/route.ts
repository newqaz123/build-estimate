import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument, updateDocument, deleteDocument } from '@/lib/db'
import type { Vendor } from '@/lib/settings-schema'

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
    const existing = await getDocument<Vendor>('vendors', id)
    if (!existing) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    const body = await request.json()
    const { name, contact, specialty } = body as { name?: string; contact?: string; specialty?: string }

    const updates: Record<string, string> = {}
    if (name !== undefined) updates.name = name
    if (contact !== undefined) updates.contact = contact
    if (specialty !== undefined) updates.specialty = specialty

    await updateDocument('vendors', id, updates)

    const updated = await getDocument<Vendor>('vendors', id)
    return NextResponse.json(updated)
  } catch (error) {
    console.error('Error updating vendor:', error)
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
    const existing = await getDocument<Vendor>('vendors', id)
    if (!existing) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    await deleteDocument('vendors', id)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting vendor:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}