import {
  doclingErrorResponse,
  invalidPdfResponse,
  requireSinglePdf,
} from '@/lib/boq-import-request'
import type { DoclingResultV2 } from '@/lib/boq-ingestion'
import { DoclingClientError } from '@/lib/docling-client'

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

    let endpoint: string
    try {
      endpoint = (await dependencies.getEndpoint()).trim() || DEFAULT_DOCLING_ENDPOINT
    } catch {
      console.error('Docling settings lookup failed')
      return Response.json({ error: 'Docling configuration is temporarily unavailable.' }, { status: 503 })
    }

    try {
      return Response.json(await dependencies.parsePdf(file, endpoint, request.signal))
    } catch (error) {
      if (error instanceof DoclingClientError) return doclingErrorResponse(error)
      console.error('Docling proxy request failed')
      return Response.json({ error: 'Docling could not process the PDF. Try again.' }, { status: 502 })
    }
  }
}
