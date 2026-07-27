import { createFirestorePreflightStore, cleanupExpiredPreflightUploads } from '@/lib/boq-preflight-storage'
import { getDb, getBucket } from '@/lib/db'

const CLEANUP_SERVER_SECRET = process.env.CLEANUP_SERVER_SECRET || ''

export async function DELETE(request: Request): Promise<Response> {
  const secret = request.headers.get('x-server-secret')
  if (secret !== CLEANUP_SERVER_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const store = createFirestorePreflightStore(getDb(), getBucket())
    const deleted = await cleanupExpiredPreflightUploads(store, new Date())
    return Response.json({ deleted })
  } catch (error) {
    console.error('Preflight cleanup failed:', error)
    return Response.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
