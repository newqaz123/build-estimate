import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { queryCollection, createDocumentWithId, getDocument } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'

function computeTotals(sections: Boq['sections']) {
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0)
  const grandTotal = sections.reduce((sum, s) => sum + s.items.reduce((s2, i) => s2 + i.total, 0), 0)
  return { totalItems, grandTotal }
}

export function parseBoqListLimit(limit: string | null): number {
  const parsed = Number.parseInt(limit ?? '', 10)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10
  }

  return Math.min(1000, parsed)
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
    const limit = parseBoqListLimit(searchParams.get('limit'))

    const where: { field: string; op: FirebaseFirestore.WhereFilterOp; value: unknown }[] = []
    if (status) where.push({ field: 'status', op: '==', value: status })
    if (workType) where.push({ field: 'workType', op: '==', value: workType })

    const { docs } = await queryCollection<Boq>('boqs', {
      // Firestore requires a separate composite index for every equality filter
      // combined with this order. Sort filtered results in memory so every valid
      // status/work-type filter can also return an empty result without a 500.
      orderByField: where.length === 0 ? 'updatedAt' : undefined,
      orderDirection: where.length === 0 ? 'desc' : undefined,
      where: where.length > 0 ? where : undefined,
    })

    let boqs = where.length > 0
      ? docs.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : docs
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
