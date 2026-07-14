import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import {
  boqSourcePath,
  deleteSourcePdf,
  isSourceObjectNotFound,
  saveSourcePdf,
} from '@/lib/boq-source-storage'
import { buildDraftBoq, type DoclingResultV2 } from '@/lib/boq-ingestion'
import { DoclingClientError, parsePdfWithDocling } from '@/lib/docling-client'
import { createDocumentWithId, getDocument } from '@/lib/db'
import type { WorkspaceSettings } from '@/lib/settings-schema'

const DEFAULT_DOCLING_ENDPOINT = 'http://localhost:5001'
const MAX_PDF_BYTES = 20 * 1024 * 1024

interface ImportDependencies {
  getWorkspaceSettings(): Promise<Pick<WorkspaceSettings, 'docling'> | null>
  saveSourcePdf(path: string, bytes: Uint8Array): Promise<void>
  parsePdfWithDocling(file: File, endpoint: string): Promise<DoclingResultV2>
  createDocumentWithId(collection: string, id: string, data: Record<string, unknown>): Promise<void>
  deleteSourcePdf(path: string): Promise<void>
}

const importDependencies: ImportDependencies = {
  getWorkspaceSettings: () => getDocument<WorkspaceSettings>('settings', 'workspace'),
  saveSourcePdf,
  parsePdfWithDocling,
  createDocumentWithId,
  deleteSourcePdf,
}

export async function importPdfAtomically(
  file: File,
  id: string,
  dependencies: ImportDependencies = importDependencies,
) {
  const sourcePath = boqSourcePath(id)
  const bytes = new Uint8Array(await file.arrayBuffer())
  let sourceSaved = false
  let persisted = false

  try {
    await dependencies.saveSourcePdf(sourcePath, bytes)
    sourceSaved = true
    const settings = await dependencies.getWorkspaceSettings()
    const parsed = await dependencies.parsePdfWithDocling(
      file,
      settings?.docling?.endpoint?.trim() || DEFAULT_DOCLING_ENDPOINT,
    )
    const draft = buildDraftBoq(id, sourcePath, parsed)
    await dependencies.createDocumentWithId('boqs', id, draft as unknown as Record<string, unknown>)
    persisted = true
    return draft
  } catch (error) {
    if (sourceSaved && !persisted) {
      try {
        await dependencies.deleteSourcePdf(sourcePath)
      } catch (rollbackError) {
        if (!isSourceObjectNotFound(rollbackError)) throw rollbackError
      }
    }
    throw error
  }
}

export function requireSinglePdf(formData: FormData): File {
  const files = formData.getAll('file')
  const file = files[0]
  const valid = files.length === 1
    && file instanceof File
    && file.size >= 1
    && file.size <= MAX_PDF_BYTES
    && file.name.toLowerCase().endsWith('.pdf')
    && file.type.toLowerCase() === 'application/pdf'
  if (!valid) throw new TypeError('Upload one PDF between 1 byte and 20 MB.')
  return file
}

function doclingErrorResponse(error: DoclingClientError): NextResponse {
  if (error.kind === 'timeout') {
    return NextResponse.json({ error: 'Docling parsing timed out. Try the import again.' }, { status: 504 })
  }
  if (error.kind === 'unreachable') {
    return NextResponse.json(
      { error: 'Docling is unreachable. Check the Docling endpoint in Settings and try again.' },
      { status: 502 },
    )
  }
  if (error.kind === 'rejected') {
    return NextResponse.json({ error: error.message }, { status: 502 })
  }
  return NextResponse.json(
    { error: 'Docling returned an invalid response. Check the sidecar and try again.' },
    { status: 502 },
  )
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let file: File
  try {
    file = requireSinglePdf(await request.formData())
  } catch {
    return NextResponse.json({ error: 'Upload one PDF between 1 byte and 20 MB.' }, { status: 400 })
  }

  try {
    const draft = await importPdfAtomically(file, crypto.randomUUID())
    return NextResponse.json(draft, { status: 201 })
  } catch (error) {
    if (error instanceof DoclingClientError) return doclingErrorResponse(error)
    console.error('BOQ import failed:', error)
    return NextResponse.json({ error: 'The BOQ import could not be saved. Try again.' }, { status: 500 })
  }
}
