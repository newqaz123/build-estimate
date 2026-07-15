import { auth } from '@/lib/auth'
import { importPdfAtomically } from '@/lib/boq-import-service'
import {
  deleteSourcePdf,
  saveSourcePdf,
  sourcePdfExists,
} from '@/lib/boq-source-storage'
import type { Boq } from '@/lib/boq-schema'
import { parsePdfWithDocling } from '@/lib/docling-client'
import { createDocumentWithId, getDocument } from '@/lib/db'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { createImportHandler } from './handler'

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
