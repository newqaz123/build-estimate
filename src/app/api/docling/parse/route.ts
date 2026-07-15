import { auth } from '@/lib/auth'
import { parsePdfWithDocling } from '@/lib/docling-client'
import { getDocument } from '@/lib/db'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { createDoclingParseHandler } from './handler'

const DEFAULT_DOCLING_ENDPOINT = 'http://localhost:5001'

export const POST = createDoclingParseHandler({
  authenticate: auth,
  getEndpoint: async () => {
    const settings = await getDocument<WorkspaceSettings>('settings', 'workspace')
    return settings?.docling?.endpoint || DEFAULT_DOCLING_ENDPOINT
  },
  parsePdf: parsePdfWithDocling,
})
