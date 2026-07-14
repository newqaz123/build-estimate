import { auth } from '@/lib/auth'
import { importPdfAtomically } from '@/lib/boq-import-service'
import {
  doclingErrorResponse,
  invalidPdfResponse,
  requireSinglePdf,
} from '@/lib/boq-import-request'
import {
  deleteSourcePdf,
  saveSourcePdf,
  sourcePdfExists,
} from '@/lib/boq-source-storage'
import type { Boq } from '@/lib/boq-schema'
import { DoclingClientError, parsePdfWithDocling } from '@/lib/docling-client'
import { createDocumentWithId, getDocument } from '@/lib/db'
import type { WorkspaceSettings } from '@/lib/settings-schema'

interface ImportHandlerDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  createId(): string
  importPdf(file: File, id: string, signal: AbortSignal): Promise<unknown>
}

export function createImportHandler(dependencies: ImportHandlerDependencies) {
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
      const draft = await dependencies.importPdf(file, dependencies.createId(), request.signal)
      return Response.json(draft, { status: 201 })
    } catch (error) {
      if (error instanceof DoclingClientError) return doclingErrorResponse(error)
      console.error('BOQ import failed')
      return Response.json({ error: 'The BOQ import could not be saved. Try again.' }, { status: 500 })
    }
  }
}

export const POST = createImportHandler({
  authenticate: auth,
  createId: () => crypto.randomUUID(),
  importPdf: (file, id, signal) => importPdfAtomically(file, id, {
    getWorkspaceSettings: () => getDocument<WorkspaceSettings>('settings', 'workspace'),
    saveSourcePdf,
    sourcePdfExists,
    parsePdfWithDocling,
    createDocumentWithId,
    getBoq: (boqId) => getDocument<Boq>('boqs', boqId),
    deleteSourcePdf,
  }, signal),
})
