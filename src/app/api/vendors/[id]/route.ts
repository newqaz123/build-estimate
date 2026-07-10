import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDb } from '@/lib/firebase-admin'

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getDb()
    const { id } = await params
    const doc = await db.collection('vendors').doc(id).get()

    if (!doc.exists) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    const body = await request.json()
    const { name, contact, specialty } = body as { name?: string; contact?: string; specialty?: string }

    const updates: Record<string, string> = { updatedAt: new Date().toISOString() }
    if (name !== undefined) updates.name = name
    if (contact !== undefined) updates.contact = contact
    if (specialty !== undefined) updates.specialty = specialty

    await db.collection('vendors').doc(id).update(updates)

    const updated = await db.collection('vendors').doc(id).get()
    return NextResponse.json({ id: updated.id, ...updated.data() })
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
    const db = getDb()
    const { id } = await params
    const doc = await db.collection('vendors').doc(id).get()

    if (!doc.exists) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 })
    }

    await db.collection('vendors').doc(id).delete()

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting vendor:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
