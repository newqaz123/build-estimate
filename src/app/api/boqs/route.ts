import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDb, createDocumentWithId, getDocument } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'

function computeTotals(sections: Boq['sections']) {
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0)
  const grandTotal = sections.reduce((sum, s) => sum + s.items.reduce((s2, i) => s2 + i.total, 0), 0)
  return { totalItems, grandTotal }
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.toLowerCase()
    const status = searchParams.get('status')
    const workType = searchParams.get('workType')
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '10', 10)))

    const db = getDb()
    let query: FirebaseFirestore.Query = db.collection('boqs').orderBy('updatedAt', 'desc')

    if (status) query = query.where('status', '==', status)
    if (workType) query = query.where('workType', '==', workType)

    const snapshot = await query.get()
    let boqs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)

    if (search) {
      boqs = boqs.filter(
        (b) => b.project.toLowerCase().includes(search) || b.vendor.toLowerCase().includes(search)
      )
    }

    const total = boqs.length
    const totalPages = Math.ceil(total / limit)
    const offset = (page - 1) * limit
    const paginated = boqs.slice(offset, offset + limit)

    return NextResponse.json({ boqs: paginated, total, page, totalPages })
  } catch (error) {
    console.error('Error fetching BOQs:', error)
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
    const { project, vendor, vendorId, workType, date, sections } = body as {
      project: string
      vendor: string
      vendorId?: string
      workType: 'Structural' | 'MEP' | 'Finishing'
      date: string
      sections?: Boq['sections']
    }

    if (!project || !vendor || !workType || !date) {
      return NextResponse.json({ error: 'project, vendor, workType, and date are required' }, { status: 400 })
    }

    if (!['Structural', 'MEP', 'Finishing'].includes(workType)) {
      return NextResponse.json({ error: 'workType must be Structural, MEP, or Finishing' }, { status: 400 })
    }

    const safeSections = sections || []
    const { totalItems, grandTotal } = computeTotals(safeSections)

    const id = crypto.randomUUID()
    const boq: Omit<Boq, 'createdAt' | 'updatedAt'> = {
      id,
      project,
      vendor,
      vendorId: vendorId || '',
      workType,
      date,
      totalItems,
      grandTotal,
      status: 'draft',
      stdStatus: 'none',
      sections: safeSections,
    }

    await createDocumentWithId('boqs', id, boq as unknown as Record<string, unknown>)
    const created = await getDocument<Boq>('boqs', id)

    return NextResponse.json(created, { status: 201 })
  } catch (error) {
    console.error('Error creating BOQ:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
