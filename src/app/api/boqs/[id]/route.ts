import type { NextRequest } from 'next/server'

import { auth } from '@/lib/auth'
import {
  deleteSourcePdf,
  loadSourcePdf,
  saveSourcePdf,
} from '@/lib/boq-source-storage'
import type { Boq } from '@/lib/boq-schema'
import { deleteDocument, getDocument, updateDocument } from '@/lib/db'
import { createBoqDetailHandlers, type BoqDetailRouteContext } from './handler'

const handlers = createBoqDetailHandlers({
  authenticate: auth,
  getBoq: (id) => getDocument<Boq>('boqs', id),
  updateBoq: (id, updates) => updateDocument('boqs', id, updates),
  deleteBoq: (id) => deleteDocument('boqs', id),
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
