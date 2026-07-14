import { auth } from '@/lib/auth'
import {
  doclingErrorResponse,
  invalidPdfResponse,
  requireSinglePdf,
} from '@/lib/boq-import-request'
import type { DoclingResultV2 } from '@/lib/boq-ingestion'
import { DoclingClientError, parsePdfWithDocling } from '@/lib/docling-client'
import { getDocument } from '@/lib/db'
import type { WorkspaceSettings } from '@/lib/settings-schema'

const DEFAULT_DOCLING_ENDPOINT = 'http://localhost:5001'

interface DoclingParseHandlerDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  getEndpoint(): Promise<string>
  parsePdf(file: File, endpoint: string, signal: AbortSignal): Promise<DoclingResultV2>
}

export function createDoclingParseHandler(dependencies: DoclingParseHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    let file: File
    try {
      file = requireSinglePdf(await request.formData())
    } catch {
      return invalidPdfResponse()
    }

    try {
      const endpoint = (await dependencies.getEndpoint()).trim() || DEFAULT_DOCLING_ENDPOINT
      return Response.json(await dependencies.parsePdf(file, endpoint, request.signal))
    } catch (error) {
      if (error instanceof DoclingClientError) return doclingErrorResponse(error)
      return Response.json({ error: 'Invalid upload request' }, { status: 400 })
    }
  }
}

export const POST = createDoclingParseHandler({
  authenticate: auth,
  getEndpoint: async () => {
    const settings = await getDocument<WorkspaceSettings>('settings', 'workspace')
    return settings?.docling?.endpoint || DEFAULT_DOCLING_ENDPOINT
  },
  parsePdf: parsePdfWithDocling,
})
