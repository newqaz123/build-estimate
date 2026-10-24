import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument, updateDocument, deleteDocument } from '@/lib/db'
import type { Estimate } from '@/lib/estimate-schema'
import { createEstimateUpdateHandler, type EstimateRouteContext } from '../handler'

const updateEstimate = createEstimateUpdateHandler({
  authenticate: () => auth(),
  getEstimate: (id) => getDocument<Estimate>('estimates', id),
  updateEstimate: async (id, updates) => {
    await updateDocument('estimates', id, updates as Record<string, unknown>)
    return getDocument<Estimate>('estimates', id)
  },
  logError: (message, error) => console.error(message, error),
})

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

export function PUT(request: NextRequest, context: EstimateRouteContext) {
  return updateEstimate(request, context)
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
