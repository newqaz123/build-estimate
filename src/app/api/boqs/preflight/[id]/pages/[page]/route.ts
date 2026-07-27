import { auth } from '@/lib/auth'
import { createFirestorePreflightStore } from '@/lib/boq-preflight-storage'
import { getDb, getBucket } from '@/lib/db'
import { createPreflightDetailHandlers } from '../../handler'
import { createPreflightAnalysisAdapter } from '@/lib/boq-preflight-analysis'
import { createPreflightStorageAdapter } from '@/lib/boq-preflight-storage-adapter'

const handlers = createPreflightDetailHandlers({
  authenticate: auth,
  createStore: () => createFirestorePreflightStore(getDb(), getBucket()),
  analysisAdapter: createPreflightAnalysisAdapter(),
  storageAdapter: createPreflightStorageAdapter(getBucket()),
  now: () => new Date(),
})

export async function GET(request: Request, context: { params: Promise<{ id: string; page: string }> }) {
  return handlers.getPage(request, context)
}
