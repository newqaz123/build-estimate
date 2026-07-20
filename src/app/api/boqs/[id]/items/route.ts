import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { runTransaction } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { normalizeStandardEntry } from '../../../standards/route'
import { deleteBoqItemAndPruneStandards } from '@/lib/boq-deletion'
import { addMissingBoqItem, MissingBoqItemError, parseMissingBoqItemRequest } from '@/lib/boq-user-entry'
import {
  applyBoqItemUpdates,
  BoqItemsValidationError,
  countBoqStandardLinks,
  parseUpdateGroups,
} from './item-updates'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const standardId = new URL(request.url).searchParams.get('stdId')?.trim()
  if (!standardId) return NextResponse.json({ error: 'stdId is required' }, { status: 400 })

  try {
    const result = await runTransaction(async (transaction, db) => {
      const [boqsSnap, standardsSnap] = await Promise.all([
        transaction.get(db.collection('boqs')),
        transaction.get(db.collection('standards')),
      ])
      const standardDoc = standardsSnap.docs.find((doc) => doc.id === standardId)
      if (!standardDoc) throw new BoqItemsValidationError('Standard not found', 404)
      const standard = normalizeStandardEntry({ id: standardDoc.id, ...standardDoc.data() } as StandardEntry)
      const boqs = boqsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)
      return { standard, ...countBoqStandardLinks(boqs, standard) }
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof BoqItemsValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error counting BOQ standard links:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  try {
    const { id } = await params
    const input = parseMissingBoqItemRequest(body)
    const itemId = `user-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const result = await runTransaction(async (transaction, db) => {
      const boqRef = db.collection('boqs').doc(id)
      const snapshot = await transaction.get(boqRef)
      if (!snapshot.exists) throw new MissingBoqItemError('BOQ not found.')
      const current = { id: snapshot.id, ...snapshot.data() } as Boq
      const updated = { ...addMissingBoqItem(current, input, itemId), updatedAt: now }
      const added = updated.sections[input.sectionIndex]!.items.at(-1)!
      transaction.update(boqRef, {
        sections: updated.sections,
        totalItems: updated.totalItems,
        grandTotal: updated.grandTotal,
        stdStatus: updated.stdStatus,
        updatedAt: now,
      })
      transaction.create(boqRef.collection('manual-entry-audit').doc(itemId), {
        action: 'add_missing_item',
        itemId,
        actorId: session.user?.id ?? 'authenticated-user',
        createdAt: now,
        entryOrigin: added.entryOrigin,
        sourceRowIds: added.sourceRowIds ?? [],
        item: added,
      })
      return updated
    })
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    if (error instanceof MissingBoqItemError) {
      return NextResponse.json({ error: error.message }, { status: /not found/i.test(error.message) ? 404 : 400 })
    }
    console.error('Error adding missing BOQ item:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

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
      const [boqsSnap, standardsSnap] = await Promise.all([
        transaction.get(db.collection('boqs')),
        transaction.get(db.collection('standards')),
      ])
      const boqs = boqsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)
      const standards = standardsSnap.docs.map((doc) => normalizeStandardEntry({ id: doc.id, ...doc.data() } as StandardEntry))
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
        const original = boqs.find((candidate) => candidate.id === updatedBoq.id)
        if (!original || original === updatedBoq) continue
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

export async function DELETE(
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
    if (!isRecord(body) || !Number.isInteger(body.sectionIndex) || Number(body.sectionIndex) < 0) {
      return NextResponse.json({ error: 'sectionIndex is required.' }, { status: 400 })
    }
    const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : ''
    const itemCode = typeof body.itemCode === 'string' ? body.itemCode.trim() : ''
    if (!itemId && !itemCode) {
      return NextResponse.json({ error: 'itemId or itemCode is required.' }, { status: 400 })
    }

    const result = await runTransaction(async (transaction, db) => {
      const [boqSnap, standardsSnap] = await Promise.all([
        transaction.get(db.collection('boqs').doc(id)),
        transaction.get(db.collection('standards')),
      ])
      if (!boqSnap.exists) throw new BoqItemsValidationError('BOQ not found', 404)
      const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
      const standards = standardsSnap.docs.map((doc) => normalizeStandardEntry({ id: doc.id, ...doc.data() } as StandardEntry))
      let applied: ReturnType<typeof deleteBoqItemAndPruneStandards>
      try {
        applied = deleteBoqItemAndPruneStandards(
          boq,
          standards,
          Number(body.sectionIndex),
          itemId ? { itemId } : { itemCode },
        )
      } catch (error) {
        throw new BoqItemsValidationError(error instanceof Error ? error.message : 'Unable to delete BOQ item.')
      }
      const now = new Date().toISOString()
      transaction.update(boqSnap.ref, {
        sections: applied.boq.sections,
        totalItems: applied.boq.totalItems,
        grandTotal: applied.boq.grandTotal,
        stdStatus: applied.boq.stdStatus,
        updatedAt: now,
      })
      applied.standards.forEach((standard, index) => {
        const previous = standards[index]
        if (JSON.stringify(previous.sourceItems ?? []) === JSON.stringify(standard.sourceItems ?? [])) return
        transaction.update(db.collection('standards').doc(standard.id), {
          sourceItems: standard.sourceItems ?? [],
          sourceBoqCount: standard.sourceBoqCount,
          updatedAt: now,
        })
      })
      return applied.boq
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof BoqItemsValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error deleting BOQ item:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
