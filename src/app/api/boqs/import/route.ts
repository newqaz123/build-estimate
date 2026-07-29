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
import { getStorageBucket } from '@/lib/firebase-admin'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { createImportHandler } from './handler'
import { createPreflightService } from '@/lib/boq-preflight-service'
import { createFirestorePreflightStore } from '@/lib/boq-preflight-storage'
import { createGcsPreflightStorageAdapter } from '@/lib/boq-preflight-storage-adapter'
import { createPreflightAnalysisAdapter } from '@/lib/boq-preflight-analysis-adapter'
import { validatePdfFile } from '@/lib/boq-import-request'

function preflightService() {
  return createPreflightService({
    store: createFirestorePreflightStore(getDb(), getStorageBucket()),
    storageAdapter: createGcsPreflightStorageAdapter({ bucket: getStorageBucket() }),
    analysisAdapter: createPreflightAnalysisAdapter(),
    requireSinglePdf: validatePdfFile,
    createId: () => crypto.randomUUID(),
    now: () => new Date(),
  })
}

export const POST = createImportHandler({
  authenticate: auth,
  createId: () => crypto.randomUUID(),
  consumePreflight: (id, actorId, selection, operation) =>
    preflightService().consumePreflight(id, actorId, selection, operation),
  importPdf: (file, id, signal, selection) => importPdfAtomically(file, id, {
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
  }, signal, selection),
})
