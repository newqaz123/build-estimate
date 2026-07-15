import type { NextRequest } from 'next/server'

import { auth } from '@/lib/auth'
import { loadSourcePdf } from '@/lib/boq-source-storage'
import type { Boq } from '@/lib/boq-schema'
import { getDocument } from '@/lib/db'
import { createSourceHandler, type SourceRouteContext } from './handler'

const sourceHandler = createSourceHandler({
  authenticate: auth,
  getBoq: (id) => getDocument<Boq>('boqs', id),
  loadSource: loadSourcePdf,
})

export async function GET(request: NextRequest, context: SourceRouteContext) {
  return sourceHandler(request, context)
}
