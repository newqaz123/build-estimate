import { createPreflightCleanupHandler } from './handler'
import { createFirestorePreflightStore, cleanupExpiredPreflightUploads } from '@/lib/boq-preflight-storage'
import { getStorageBucket } from '@/lib/firebase-admin'
import { getDb } from '@/lib/db'

const secret = process.env.CLEANUP_SERVER_SECRET ?? ''

export const { DELETE } = createPreflightCleanupHandler({
  secret,
  cleanup: async () => {
    const store = createFirestorePreflightStore(getDb(), getStorageBucket())
    return cleanupExpiredPreflightUploads(store, new Date(), 100)
  },
})
