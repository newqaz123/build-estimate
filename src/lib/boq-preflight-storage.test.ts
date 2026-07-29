import assert from 'node:assert/strict'
import test from 'node:test'
import type { PreflightUpload } from './boq-preflight-schema'
import { cleanupExpiredPreflightUploads, createFirestorePreflightStore, type PreflightStore, type PreflightRecord } from './boq-preflight-storage'

function seed(ownerId: string): PreflightRecord {
  return {
    ownerId, id: `upload-${ownerId}`, fileName: 'source.pdf', pageCount: 1, status: 'uploaded',
    pages: [{ page: 1, suggested: true, confidence: 1, reasons: [], textSource: 'embedded' }],
    confirmedPages: null, sourceDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', sourceName: 'source.pdf', sourceType: 'application/pdf', sourceSize: 3,
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


class FakeSnapshot {
  constructor(public readonly ref: FakeRef, private readonly value?: Record<string, unknown>) {}
  get exists(): boolean { return this.value !== undefined }
  data(): Record<string, unknown> | undefined { return this.value }
  get id(): string { return this.ref.id }
}

class FakeRef {
  constructor(public readonly db: FakeDb, public readonly path: string) {}
  get id(): string { return this.path.split('/').at(-1)! }
  get parent(): FakeCollection { return new FakeCollection(this.db, this.path.split('/').slice(0, -1).join('/')) }
  async get(): Promise<FakeSnapshot> { return new FakeSnapshot(this, this.db.docs.get(this.path)) }
  async delete(): Promise<void> { this.db.docs.delete(this.path) }
}
class FakeCollection {
  constructor(public readonly db: FakeDb, public readonly path: string) {}
  get parent(): FakeRef | undefined {
    const parts = this.path.split('/'); return parts.length >= 2 ? new FakeRef(this.db, parts.slice(0, -1).join('/')) : undefined
  }
  doc(id: string): FakeRef { return new FakeRef(this.db, `${this.path}/${id}`) }
}
class FakeTransaction {
  constructor(private readonly db: FakeDb) {}
  async get(ref: FakeRef): Promise<FakeSnapshot> { return ref.get() }
  create(ref: FakeRef, data: Record<string, unknown>): void { if (this.db.docs.has(ref.path)) throw new Error('exists'); this.db.docs.set(ref.path, data) }
  update(ref: FakeRef, patch: Record<string, unknown>): void { this.db.docs.set(ref.path, { ...this.db.docs.get(ref.path), ...patch }) }
  delete(ref: FakeRef): void { this.db.docs.delete(ref.path) }
}
class FakeQuery {
  private cutoff?: string; private max = Infinity
  constructor(private readonly db: FakeDb) {}
  where(_field: string, _op: string, value: string): FakeQuery { this.cutoff = value; return this }
  limit(value: number): FakeQuery { this.max = value; return this }
  async get(): Promise<{ docs: FakeSnapshot[] }> {
    const docs = [...this.db.docs.entries()].filter(([path, value]) => path.includes('/uploads/') && (!this.cutoff || String(value.expiresAt) <= this.cutoff)).slice(0, this.max)
    return { docs: docs.map(([path, value]) => new FakeSnapshot(new FakeRef(this.db, path), value)) }
  }
}
class FakeDb {
  readonly docs = new Map<string, Record<string, unknown>>()
  doc(path: string): FakeRef { return new FakeRef(this, path) }
  collectionGroup(name: string): FakeQuery { if (name !== 'uploads') throw new Error('unexpected collection'); return new FakeQuery(this) }
  async runTransaction<T>(fn: (transaction: FakeTransaction) => Promise<T>): Promise<T> { return fn(new FakeTransaction(this)) }
}
class FakeBucket {
  readonly deletedPaths: string[] = []
  readonly missing = new Set<string>()
  file(path: string): { delete: () => Promise<void> } {
    return { delete: async () => { if (this.missing.has(path)) throw Object.assign(new Error('missing'), { code: 404 }); this.deletedPaths.push(path) } }
  }
}

function firestoreHarness(clock = new Date('2026-07-27T00:00:00.000Z')) {
  const db = new FakeDb(); const bucket = new FakeBucket()
  return { db, bucket, store: createFirestorePreflightStore(db as never, bucket as never, () => clock) }
}

test('create accepts an uploaded record with pageCount 0 (page count unknown until analysis)', async () => {
  const harness = firestoreHarness()
  const uploaded = await harness.store.create({ ...seed('owner-a'), pageCount: 0, pages: [] })
  assert.equal(uploaded.pageCount, 0)
  assert.equal(uploaded.status, 'uploaded')
  const reloaded = await harness.store.getOwned(uploaded.id, 'owner-a')
  assert.equal(reloaded?.pageCount, 0)
  // A negative pageCount is still invalid.
  await assert.rejects(() => harness.store.create({ ...seed('owner-b'), pageCount: -1 }), /non-negative integer/)
})

test('Firestore adapter rejects invalid transitions and cleans up on cancel from uploaded', async () => {
  const harness = firestoreHarness()
  const upload = await harness.store.create(seed('owner-a'))
  assert.equal((await harness.store.getOwned(upload.id, 'owner-a'))?.status, 'uploaded')
  // uploaded -> consumed is invalid: consumption requires analyzing -> ready first
  await assert.rejects(() => harness.store.update(upload.id, 'owner-a', { status: 'consumed' }), /Invalid preflight transition/)
  // cancellation is allowed directly from an active state and deletes all artifacts
  const cancelled = await harness.store.update(upload.id, 'owner-a', { status: 'cancelled' })
  assert.equal(cancelled, null)
  assert.equal(await harness.store.getOwned(upload.id, 'owner-a'), null)
  assert.deepEqual(harness.bucket.deletedPaths, [
    `preflight/owner-a/${upload.id}/source.pdf`,
    `preflight/owner-a/${upload.id}/previews/1.png`,
    `preflight/owner-a/${upload.id}/ocr/1.json`,
  ])
})

test('consumed transition from ready deletes source, preview, and OCR artifacts', async () => {
  const harness = firestoreHarness()
  const upload = await harness.store.create(seed('owner-a'))
  await harness.store.update(upload.id, 'owner-a', { status: 'analyzing' })
  await harness.store.update(upload.id, 'owner-a', { status: 'ready' })
  const consumed = await harness.store.update(upload.id, 'owner-a', { status: 'consumed' })
  assert.equal(consumed, null)
  assert.equal(await harness.store.getOwned(upload.id, 'owner-a'), null)
  assert.deepEqual(harness.bucket.deletedPaths, [
    `preflight/owner-a/${upload.id}/source.pdf`,
    `preflight/owner-a/${upload.id}/previews/1.png`,
    `preflight/owner-a/${upload.id}/ocr/1.json`,
  ])
})

test('failed state only allows retry or terminal transitions', async () => {
  const harness = firestoreHarness()
  const upload = await harness.store.create(seed('owner-a'))
  await harness.store.update(upload.id, 'owner-a', { status: 'analyzing' })
  await harness.store.update(upload.id, 'owner-a', { status: 'failed', preserveForRetry: true })
  // failed -> ready is rejected: a retry must re-enter analyzing first
  await assert.rejects(() => harness.store.update(upload.id, 'owner-a', { status: 'ready' }), /Invalid preflight transition: failed -> ready/)
  // failed -> analyzing is the allowed retry path
  const retry = await harness.store.update(upload.id, 'owner-a', { status: 'analyzing' })
  assert.equal(retry?.status, 'analyzing')
})

test('failed preserveForRetry retains record and artifacts; failed cleanup deletes them', async () => {
  const keep = firestoreHarness(); const upload = await keep.store.create(seed('keep'))
  const retained = await keep.store.update(upload.id, 'keep', { status: 'analyzing' })
  assert.equal(retained?.status, 'analyzing')
  const failed = await keep.store.update(upload.id, 'keep', { status: 'failed', preserveForRetry: true })
  assert.equal(failed?.status, 'failed'); assert.ok(await keep.store.getOwned(upload.id, 'keep'))

  const remove = firestoreHarness(); const doomed = await remove.store.create(seed('remove'))
  await remove.store.update(doomed.id, 'remove', { status: 'failed' })
  assert.equal(await remove.store.getOwned(doomed.id, 'remove'), null)
  assert.deepEqual(remove.bucket.deletedPaths, [
    `preflight/remove/${doomed.id}/source.pdf`,
    `preflight/remove/${doomed.id}/previews/1.png`,
    `preflight/remove/${doomed.id}/ocr/1.json`,
  ])
})

test('expired cleanup lease uses invocation time and blocks a concurrent claim', async () => {
  const invocation = new Date('2026-07-27T00:00:00.000Z'); const cleanupClock = new Date('2026-07-27T00:10:00.000Z'); const harness = firestoreHarness(cleanupClock)
  const upload = await harness.store.create(seed('owner-a'))
  const claimed = await harness.store.claimExpired(invocation, 10)
  assert.deepEqual(claimed, [{ id: upload.id, ownerId: 'owner-a' }])
  const secondClaim = await harness.store.claimExpired(new Date(invocation.getTime() + 60_000), 10)
  assert.deepEqual(secondClaim, [])
  const stored = await harness.store.getOwned(upload.id, 'owner-a')
  assert.equal(stored?.cleanupLeaseExpiresAt, '2026-07-27T00:15:00.000Z')
})

test('consume returns a single-winner outcome for repeated attempts', async () => {
  const harness = firestoreHarness()
  const upload = await harness.store.create(seed('owner-a'))
  await harness.store.update(upload.id, 'owner-a', { status: 'analyzing' })
  await harness.store.update(upload.id, 'owner-a', { status: 'ready' })
  const consumed = await harness.store.consume!(upload.id, 'owner-a', [1])
  const loser = await harness.store.consume!(upload.id, 'owner-a', [1])
  assert.equal(consumed, 'consumed')
  assert.equal(loser, 'missing')
})

test('active reservation lease blocks cleanup while expired abandoned lease is reclaimable', async () => {
  const now = new Date('2026-07-27T00:10:00.000Z')
  const harness = firestoreHarness(now)
  const upload = await harness.store.create(seed('owner-a'))
  await harness.store.update(upload.id, 'owner-a', {
    status: 'analyzing',
    importReservationToken: 'active-token',
    importReservationLeaseExpiresAt: '2026-07-27T00:15:00.000Z',
  })
  assert.deepEqual(await harness.store.claimExpired(new Date('2026-07-27T00:01:00.000Z'), 10), [])

  const path = `preflightUploads/owner-a/uploads/${upload.id}`
  const current = harness.db.docs.get(path)!
  harness.db.docs.set(path, { ...current, importReservationLeaseExpiresAt: '2026-07-27T00:05:00.000Z' })
  assert.deepEqual(
    await harness.store.claimExpired(new Date('2026-07-27T00:10:00.000Z'), 10),
    [{ id: upload.id, ownerId: 'owner-a' }],
  )
})

test('missing preview and OCR artifacts do not prevent cleanup', async () => {
  const harness = firestoreHarness(); const upload = await harness.store.create(seed('owner-a'))
  harness.bucket.missing.add(`preflight/owner-a/${upload.id}/previews/1.png`)
  harness.bucket.missing.add(`preflight/owner-a/${upload.id}/ocr/1.json`)
  await harness.store.update(upload.id, 'owner-a', { status: 'analyzing' })
  await harness.store.update(upload.id, 'owner-a', { status: 'cancelled' })
  assert.equal(await harness.store.getOwned(upload.id, 'owner-a'), null)
  assert.deepEqual(harness.bucket.deletedPaths, [`preflight/owner-a/${upload.id}/source.pdf`])
})

void ({} as PreflightUpload)
