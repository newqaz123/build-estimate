import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import type { Estimate, EstimateItem } from '@/lib/estimate-schema'

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getDb()
    const snapshot = await db.collection('estimates').orderBy('updatedAt', 'desc').get()
    const estimates: Estimate[] = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Estimate[]

    return NextResponse.json({ estimates })
  } catch (error) {
    console.error('Error fetching estimates:', error)
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
    const { name, project, date, notes, items } = body as {
      name: string
      project?: string
      date: string
      notes?: string
      items?: EstimateItem[]
    }

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const estimateItems = items || []
    const totalAmount = estimateItems.reduce((sum, item) => sum + (item.total || 0), 0)
    const id = crypto.randomUUID()

    const estimate: Estimate = {
      id,
      name,
      project: project || '',
      date: date || '',
      notes: notes || '',
      items: estimateItems,
      totalAmount,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }

    const db = getDb()
    await db.collection('estimates').doc(id).set(estimate)

    return NextResponse.json(estimate, { status: 201 })
  } catch (error) {
    console.error('Error creating estimate:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
