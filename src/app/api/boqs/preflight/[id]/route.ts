import { auth } from '@/lib/auth'
import { createPreflightHandlers } from '@/lib/boq-preflight-api'
import { createPreflightService } from '@/lib/boq-preflight-service'
import { createFirestorePreflightStore, cleanupExpiredPreflightUploads } from '@/lib/boq-preflight-storage'
import { createGcsPreflightStorageAdapter } from '@/lib/boq-preflight-storage-adapter'
import { createPreflightAnalysisAdapter } from '@/lib/boq-preflight-analysis-adapter'
import { requireSinglePdf } from '@/lib/boq-import-request'
import { getStorageBucket } from '@/lib/firebase-admin'
import { getDb } from '@/lib/db'

export const { GET, PATCH, DELETE } = createPreflightHandlers({
  authenticate: auth,
  createPreflight: (file, actorId) => {
    const store = createFirestorePreflightStore(getDb(), getStorageBucket())
    const storageAdapter = createGcsPreflightStorageAdapter({ bucket: getStorageBucket() })
    const analysisAdapter = createPreflightAnalysisAdapter()
    const service = createPreflightService({
      store,
      storageAdapter,
      analysisAdapter,
      requireSinglePdf,
      createId: () => crypto.randomUUID(),
      now: () => new Date(),
    })
    return service.createPreflight(file, actorId)
  },
  getPreflight: (id, ownerId) => {
    const store = createFirestorePreflightStore(getDb(), getStorageBucket())
    return store.getOwned(id, ownerId).then(record => record ? {
      id: record.id,
      fileName: record.fileName,
      pageCount: record.pageCount,
      status: record.status,
      pages: record.pages,
      confirmedPages: record.confirmedPages,
    } : null)
  },
  consumePreflight: (id, actorId, selection) => {
    const store = createFirestorePreflightStore(getDb(), getStorageBucket())
    const storageAdapter = createGcsPreflightStorageAdapter({ bucket: getStorageBucket() })
    const analysisAdapter = createPreflightAnalysisAdapter()
    const service = createPreflightService({
      store,
      storageAdapter,
      analysisAdapter,
      requireSinglePdf,
      createId: () => crypto.randomUUID(),
      now: () => new Date(),
    })
    return service.consumePreflight(id, actorId, selection)
  },
  cancelPreflight: (id, actorId) => {
    const store = createFirestorePreflightStore(getDb(), getStorageBucket())
    const storageAdapter = createGcsPreflightStorageAdapter({ bucket: getStorageBucket() })
    const analysisAdapter = createPreflightAnalysisAdapter()
    const service = createPreflightService({
      store,
      storageAdapter,
      analysisAdapter,
      requireSinglePdf,
      createId: () => crypto.randomUUID(),
      now: () => new Date(),
    })
    return service.cancelPreflight(id, actorId)
  },
  requireSinglePdf,
})
