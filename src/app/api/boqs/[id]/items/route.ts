import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { runTransaction } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import {
  applyBoqItemUpdates,
  BoqItemsValidationError,
  parseUpdateGroups,
} from './item-updates'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
    }
    const groups = parseUpdateGroups(body)
    const result = await runTransaction(async (transaction, db) => {
      const [boqsSnapshot, standardsSnapshot] = await Promise.all([
        transaction.get(db.collection('boqs')),
        transaction.get(db.collection('standards')),
      ])
      const boqs = boqsSnapshot.docs.map((document) => ({ id: document.id, ...document.data() }) as Boq)
      const standards = standardsSnapshot.docs.map(
        (document) => ({ id: document.id, ...document.data() }) as StandardEntry,
      )
      const applied = applyBoqItemUpdates(boqs, standards, id, groups)
      const now = new Date().toISOString()

      for (const standard of applied.standards) {
        const previous = standards.find((candidate) => candidate.id === standard.id)
        if (!previous || previous.description === standard.description && previous.unit === standard.unit) continue
        transaction.update(db.collection('standards').doc(standard.id), {
          description: standard.description,
          unit: standard.unit,
          updatedAt: now,
        })
      }

      for (const updatedBoq of applied.boqs) {
        const previous = boqs.find((candidate) => candidate.id === updatedBoq.id)
        if (!previous || previous === updatedBoq) continue
        transaction.update(db.collection('boqs').doc(updatedBoq.id), {
          sections: updatedBoq.sections,
          totalItems: updatedBoq.totalItems,
          grandTotal: updatedBoq.grandTotal,
          stdStatus: updatedBoq.stdStatus,
          updatedAt: now,
        })
      }

      return { ...applied, boq: applied.boqs.find((boq) => boq.id === id) }
    })

    return NextResponse.json({
      ...result.boq,
      sync: {
        affectedItems: result.affectedItems,
        affectedBoqs: result.affectedBoqs,
        affectedLinkCount: result.affectedLinkCount,
      },
    })
  } catch (error) {
    if (error instanceof BoqItemsValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error updating BOQ items:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
