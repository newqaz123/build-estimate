import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { queryCollection, getDocument, createDocumentWithId } from '@/lib/db'
import type { Estimate } from '@/lib/estimate-schema'
import { createEstimateCreateHandler } from './handler'

const createEstimate = createEstimateCreateHandler({
  authenticate: () => auth(),
  newId: () => crypto.randomUUID(),
  createEstimate: async (id, estimate) => {
    await createDocumentWithId('estimates', id, estimate as unknown as Record<string, unknown>)
    return getDocument<Estimate>('estimates', id)
  },
  logError: (message, error) => console.error(message, error),
})

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

export function POST(request: NextRequest) {
  return createEstimate(request)
}