import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import type { Vendor } from '@/lib/settings-schema'

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getDb()
    const snapshot = await db.collection('vendors').orderBy('name', 'asc').get()
    const vendors: Vendor[] = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Vendor[]

    return NextResponse.json(vendors)
  } catch (error) {
    console.error('Error fetching vendors:', error)
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
    const { name, contact, specialty } = body as { name: string; contact: string; specialty: string }

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const vendor: Vendor = {
      id,
      name,
      contact: contact || '',
      specialty: specialty || '',
      linkedBoqCount: 0,
      lastUsed: now,
      createdAt: now,
      updatedAt: now,
    }

    const db = getDb()
    await db.collection('vendors').doc(id).set(vendor)

    return NextResponse.json(vendor, { status: 201 })
  } catch (error) {
    console.error('Error creating vendor:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}