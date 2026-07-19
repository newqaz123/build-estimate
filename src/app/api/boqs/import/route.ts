import { auth } from '@/lib/auth'
import { importPdfAtomically } from '@/lib/boq-import-service'
import { createFirestoreExtractionStore } from '@/lib/boq-extraction-storage'
import {
  deleteSourcePdf,
  saveSourcePdf,
  sourcePdfExists,
} from '@/lib/boq-source-storage'
import type { Boq } from '@/lib/boq-schema'
import { parsePdfWithDocling } from '@/lib/docling-client'
import { createDocumentWithId, getDb, getDocument } from '@/lib/db'
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
    createRunId: () => crypto.randomUUID(),
    now: () => new Date(),
    extractionStore: createFirestoreExtractionStore(getDb()),
  }, signal),
})
