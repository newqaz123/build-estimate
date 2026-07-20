import { auth } from '@/lib/auth'
import { getDocument, getDb } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { loadSourcePdf } from '@/lib/boq-source-storage'
import { parsePdfWithDocling } from '@/lib/docling-client'
import { createFirestoreReextractionPersistence } from '@/lib/boq-reextract-persistence'
import { createReextractHandler, type ReextractRouteContext } from './handler'

const DEFAULT_DOCLING_ENDPOINT = 'http://localhost:5001'

const handler = createReextractHandler({
  authenticate: auth,
  getBoq: (id) => getDocument<Boq>('boqs', id),
  loadSource: loadSourcePdf,
  parsePdfWithDocling: (file, endpoint) => parsePdfWithDocling(file, endpoint),
  createRunId: () => crypto.randomUUID(),
  now: () => new Date(),
  getEndpoint: async () => {
    const settings = await getDocument<WorkspaceSettings>('settings', 'workspace')
    return settings?.docling?.endpoint?.trim() || DEFAULT_DOCLING_ENDPOINT
  },
  persistRun: (input) => createFirestoreReextractionPersistence(getDb())(input),
})

export async function POST(request: Request, context: ReextractRouteContext) {
  return handler(request, context)
}
