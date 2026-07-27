import { auth } from '@/lib/auth'
import { createFirestorePreflightStore } from '@/lib/boq-preflight-storage'
import { getDb, getBucket } from '@/lib/db'
import { createPreflightRouteHandlers } from './handler'
import { createPreflightAnalysisAdapter } from '@/lib/boq-preflight-analysis'
import { createPreflightStorageAdapter } from '@/lib/boq-preflight-storage-adapter'

export const POST = createPreflightRouteHandlers({
  authenticate: auth,
  createStore: () => createFirestorePreflightStore(getDb(), getBucket()),
  analysisAdapter: createPreflightAnalysisAdapter(),
  storageAdapter: createPreflightStorageAdapter(getBucket()),
  now: () => new Date(),
}).POST
