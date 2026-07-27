import assert from 'node:assert/strict'
import test from 'node:test'
import type { PreflightUpload } from './boq-preflight-schema'
import { cleanupExpiredPreflightUploads, type PreflightStore, type PreflightRecord } from './boq-preflight-storage'

function seed(ownerId: string): PreflightRecord {
  return {
    ownerId, id: `upload-${ownerId}`, fileName: 'source.pdf', pageCount: 1, status: 'uploaded',
    pages: [{ page: 1, suggested: true, confidence: 1, reasons: [], textSource: 'embedded' }],
    confirmedPages: null, sourceDigest: 'sha256:test', sourceName: 'source.pdf', sourceType: 'application/pdf', sourceSize: 3,
    expiresAt: '2026-07-26T00:00:00.000Z', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
  }
}

function harness(initial: PreflightRecord[]): PreflightStore & { deletedPaths: string[] } {
  const records = new Map(initial.map((record) => [`${record.ownerId}/${record.id}`, record]))
  const deletedPaths: string[] = []
  return {
    deletedPaths,
    async create(record) { const stored = record as PreflightRecord; records.set(`${stored.ownerId}/${stored.id}`, stored); return stored },
    async getOwned(id, ownerId) { return records.get(`${ownerId}/${id}`) ?? null },
    async update(id, ownerId, patch) {
      const key = `${ownerId}/${id}`; const current = records.get(key); if (!current) return null
      const result = { ...current, ...patch } as PreflightRecord; records.set(key, result); return result
    },
    async deleteArtifacts(id, ownerId) {
      const key = `${ownerId}/${id}`; const record = records.get(key); if (!record) return false
      deletedPaths.push(`preflight/${ownerId}/${id}/source.pdf`, `preflight/${ownerId}/${id}/previews/1.png`, `preflight/${ownerId}/${id}/ocr/1.json`)
      records.delete(key); return true
    },
    async claimExpired(now, limit) {
      return [...records.values()].filter((record) => Date.parse(record.expiresAt) <= now.getTime()).slice(0, limit).map((record) => ({ id: record.id, ownerId: record.ownerId }))
    },
  }
}

test('preflight cleanup is bounded and owner-scoped', async () => {
  const store = harness([])
  const upload = await store.create(seed('owner-a'))
  assert.equal((await store.getOwned(upload.id, 'owner-a'))?.status, 'uploaded')
  assert.equal(await store.getOwned(upload.id, 'owner-b'), null)
  assert.equal(await cleanupExpiredPreflightUploads(store, new Date('2026-07-27T00:00:00Z'), 10), 1)
  assert.deepEqual(store.deletedPaths, [
    `preflight/owner-a/${upload.id}/source.pdf`,
    `preflight/owner-a/${upload.id}/previews/1.png`,
    `preflight/owner-a/${upload.id}/ocr/1.json`,
  ])
})

test('cleanup rejects unbounded requests', async () => {
  await assert.rejects(() => cleanupExpiredPreflightUploads(harness([]), new Date(), 201), /between 1 and 200/)
})

// Keep the contract import checked by TypeScript even when this test is run alone.
void ({} as PreflightUpload)
