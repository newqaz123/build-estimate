import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { queryCollection, getDocument, createDocumentWithId } from '@/lib/db'
import type { Estimate, EstimateItem } from '@/lib/estimate-schema'

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { docs } = await queryCollection<Estimate>('estimates', {
      orderByField: 'updatedAt',
      orderDirection: 'desc',
    })

    return NextResponse.json({ estimates: docs })
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

    const estimateItems = items || []
    const totalAmount = estimateItems.reduce((sum, item) => sum + (item.total || 0), 0)
    const id = crypto.randomUUID()

    const estimate: Omit<Estimate, 'createdAt' | 'updatedAt'> = {
      id,
      name,
      project: project || '',
      date: date || '',
      notes: notes || '',
      items: estimateItems,
      totalAmount,
      status: 'draft',
    }

    await createDocumentWithId('estimates', id, estimate as unknown as Record<string, unknown>)
    const created = await getDocument<Estimate>('estimates', id)

    return NextResponse.json(created, { status: 201 })
  } catch (error) {
    console.error('Error creating estimate:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}