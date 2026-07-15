import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument, updateDocument } from '@/lib/db'
import type { Boq, BoqItem } from '@/lib/boq-schema'
import { parseBoqItemRequestIdentity, resolveBoqItemIdentity } from '@/lib/boq-item-identity'

type BoqItemPatch = Partial<BoqItem> & { itemId?: string; itemCode?: string }

function computeTotals(sections: Boq['sections']) {
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0)
  const grandTotal = sections.reduce((sum, s) => sum + s.items.reduce((s2, i) => s2 + i.total, 0), 0)
  return { totalItems, grandTotal }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const boq = await getDocument<Boq>('boqs', id)
    if (!boq) {
      return NextResponse.json({ error: 'BOQ not found' }, { status: 404 })
    }

    const body = await request.json()
    const { sectionIndex, items } = body as {
      sectionIndex: number
      items: BoqItemPatch[]
    }

    if (sectionIndex === undefined || !Array.isArray(items)) {
      return NextResponse.json({ error: 'sectionIndex and items are required' }, { status: 400 })
    }

    if (sectionIndex < 0 || sectionIndex >= boq.sections.length) {
      return NextResponse.json({ error: 'Invalid sectionIndex' }, { status: 400 })
    }

    const updatesByIndex = new Map<number, BoqItemPatch>()
    for (const update of items) {
      const identity = parseBoqItemRequestIdentity(update as Record<string, unknown>)
      if (!identity) {
        return NextResponse.json({ error: 'Each item update requires a valid itemId or itemCode' }, { status: 400 })
      }
      const resolution = resolveBoqItemIdentity(boq.sections[sectionIndex].items, identity)
      if (resolution.status === 'ambiguous') {
        return NextResponse.json({ error: 'BOQ item identity is ambiguous' }, { status: 400 })
      }
      if (resolution.status !== 'found') {
        return NextResponse.json({ error: 'BOQ item not found' }, { status: 400 })
      }
      if (updatesByIndex.has(resolution.index)) {
        return NextResponse.json({ error: 'Duplicate BOQ item update' }, { status: 400 })
      }
      updatesByIndex.set(resolution.index, update)
    }

    const section = { ...boq.sections[sectionIndex] }
    section.items = section.items.map((existing, itemIndex) => {
      const update = updatesByIndex.get(itemIndex)
      if (!update) return existing
      const changes = { ...update }
      delete changes.itemId
      delete changes.itemCode
      return { ...existing, ...changes }
    })

    const updatedSections = [...boq.sections]
    updatedSections[sectionIndex] = section

    const { totalItems, grandTotal } = computeTotals(updatedSections)

    await updateDocument('boqs', id, {
      sections: updatedSections,
      totalItems,
      grandTotal,
    })

    const updated = await getDocument<Boq>('boqs', id)
    return NextResponse.json(updated)
  } catch (error) {
    console.error('Error updating BOQ items:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
