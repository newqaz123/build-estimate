import type { NextRequest } from 'next/server'

import { auth } from '@/lib/auth'
import {
  deleteSourcePdf,
  loadSourcePdf,
  saveSourcePdf,
} from '@/lib/boq-source-storage'
import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { getDocument, runTransaction } from '@/lib/db'
import { pruneBoqFromStandards } from '@/lib/boq-deletion'
import { createBoqDetailHandlers, type BoqDetailRouteContext } from './handler'

const handlers = createBoqDetailHandlers({
  authenticate: auth,
  getBoq: (id) => getDocument<Boq>('boqs', id),
  updateBoq: (id, prepareUpdate) => runTransaction(async (transaction, db) => {
    const ref = db.collection('boqs').doc(id)
    const snapshot = await transaction.get(ref)
    if (!snapshot.exists) return 'not-found'
    if (snapshot.data()?.status === 'approved') return 'approved'
    const current = { id: snapshot.id, ...snapshot.data() } as Boq
    const decision = prepareUpdate(current)
    if (decision.kind === 'rejected') return decision
    transaction.update(ref, { ...decision.updates, updatedAt: new Date().toISOString() })
    return 'updated'
  }),
  deleteBoq: (id) => runTransaction(async (transaction, db) => {
    const [boqSnap, standardsSnap] = await Promise.all([
      transaction.get(db.collection('boqs').doc(id)),
      transaction.get(db.collection('standards')),
    ])
    if (!boqSnap.exists) return
    const standards = standardsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as StandardEntry)
    const pruned = pruneBoqFromStandards(id, standards)
    const now = new Date().toISOString()
    pruned.forEach((standard, index) => {
      const previous = standards[index]
      if (JSON.stringify(previous.sourceItems ?? []) === JSON.stringify(standard.sourceItems ?? [])) return
      transaction.update(db.collection('standards').doc(standard.id), {
        sourceItems: standard.sourceItems ?? [],
        sourceBoqCount: standard.sourceBoqCount,
        updatedAt: now,
      })
    })
    transaction.delete(boqSnap.ref)
  }),
  loadSource: loadSourcePdf,
  deleteSource: deleteSourcePdf,
  saveSource: saveSourcePdf,
  logError: (message, error) => { console.error(message, error) },
})

export async function GET(request: NextRequest, context: BoqDetailRouteContext) {
  return handlers.GET(request, context)
}

export async function PUT(request: NextRequest, context: BoqDetailRouteContext) {
  return handlers.PUT(request, context)
}

export async function DELETE(request: NextRequest, context: BoqDetailRouteContext) {
  return handlers.DELETE(request, context)
}
