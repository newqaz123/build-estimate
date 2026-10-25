import { createPreflightCleanupHandler } from './handler'
import { createFirestorePreflightStore, cleanupExpiredPreflightUploads } from '@/lib/boq-preflight-storage'
import { getStorageBucket } from '@/lib/firebase-admin'
import { getDb } from '@/lib/db'

export const { GET, DELETE } = createPreflightCleanupHandler({
  secret: process.env.CLEANUP_SERVER_SECRET ?? '',
  cronSecret: process.env.CRON_SECRET ?? '',
  cleanup: async () => {
    const store = createFirestorePreflightStore(getDb(), getStorageBucket())
    return cleanupExpiredPreflightUploads(store, new Date(), 100)
  },
})
