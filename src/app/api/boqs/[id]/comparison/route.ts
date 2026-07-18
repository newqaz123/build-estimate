import { NextRequest, NextResponse } from 'next/server'

import { auth } from '@/lib/auth'
import { getDocument, queryCollection } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { compareBoqToCatalog } from '@/lib/boq-catalog-comparison'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const [{ docs: boqs }, { docs: standards }, settings] = await Promise.all([
      queryCollection<Boq>('boqs'),
      queryCollection<StandardEntry>('standards'),
      getDocument<{ fuzzy?: { unitMap?: Record<string, string> } }>('settings', 'workspace'),
    ])
    const target = boqs.find((boq) => boq.id === id)
    if (!target) return NextResponse.json({ error: 'BOQ not found' }, { status: 404 })
    return NextResponse.json(compareBoqToCatalog(target, standards, boqs, settings?.fuzzy?.unitMap ?? {}))
  } catch (error) {
    console.error('Error comparing BOQ to catalog:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
