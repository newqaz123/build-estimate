import assert from 'node:assert/strict'
import test from 'node:test'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import { checksumSourceRows, type BoqExtractionRun } from './boq-extraction-run'
import { ReextractError } from './boq-reextract'
import { createFirestoreReextractionPersistence } from './boq-reextract-persistence'

type Stored = Record<string, unknown>

class MemoryRef {
  constructor(readonly path: string, private readonly records: Map<string, Stored>) {}
  get id() { return this.path.split('/').at(-1) ?? '' }
  async get() { return snapshot(this, this.records.get(this.path)) }
  collection(name: string) { return new MemoryCollection(`${this.path}/${name}`, this.records) }
}

class MemoryCollection {
  constructor(readonly path: string, private readonly records: Map<string, Stored>) {}
  doc(id: string) { return new MemoryRef(`${this.path}/${id}`, this.records) }
  async get() {
    const prefix = `${this.path}/`
    const docs = [...this.records.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, data]) => snapshot(new MemoryRef(path, this.records), data))
    return { docs }
  }
}

function snapshot(ref: MemoryRef, data: Stored | undefined) {
  return { id: ref.id, ref, exists: data !== undefined, data: () => data ? structuredClone(data) : undefined }
}

function raceDb() {
  const records = new Map<string, Stored>([[
    'boqs/boq-1',
    { id: 'boq-1', status: 'draft', activeExtractionRunId: 'run-original' },
  ]])
  let approvalInjected = false
  const db = {
    doc: (path: string) => new MemoryRef(path, records),
    collection: (path: string) => new MemoryCollection(path, records),
    runTransaction: async <T>(callback: (transaction: {
      get(ref: MemoryRef): Promise<ReturnType<typeof snapshot>>
      getAll(...refs: MemoryRef[]): Promise<Array<ReturnType<typeof snapshot>>>
      create(ref: MemoryRef, data: Stored): void
      update(ref: MemoryRef, data: Stored): void
    }) => Promise<T>) => {
      const writes: Array<() => void> = []
      const transaction = {
        get: async (ref: MemoryRef) => {
          const run = records.get('boqs/boq-1/extractionRuns/run-race')
          if (ref.path === 'boqs/boq-1' && run?.verifiedSourceRowCount === 1 && !approvalInjected) {
            records.set(ref.path, { ...records.get(ref.path), status: 'approved' })
            approvalInjected = true
          }
          return snapshot(ref, records.get(ref.path))
        },
        getAll: async (...refs: MemoryRef[]) => refs.map((ref) => snapshot(ref, records.get(ref.path))),
        create: (ref: MemoryRef, data: Stored) => writes.push(() => {
          if (records.has(ref.path)) throw new Error('already exists')
          records.set(ref.path, structuredClone(data))
        }),
        update: (ref: MemoryRef, data: Stored) => writes.push(() => {
          const previous = records.get(ref.path)
          if (!previous) throw new Error('missing document')
          records.set(ref.path, { ...previous, ...structuredClone(data) })
        }),
      }
      const result = await callback(transaction)
      writes.forEach((write) => write())
      return result
    },
  }
  return { db, records, wasApprovalInjected: () => approvalInjected }
}

test('final persistence rejects an approval race without changing the active run pointer', async () => {
  const row = {
    id: 'row-1', page: 1, table: 1, row: 1, section: null, headers: [], rawCells: [],
    rawText: 'item', classification: 'item', confidence: 1, warnings: [],
  } as BoqSourceRowV3
  const run = {
    id: 'run-race', boqId: 'boq-1', contractVersion: 3, status: 'staging',
    createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
    stagingExpiresAt: '2026-07-21T00:00:00.000Z', sourceFile: { path: 'source.pdf', name: 'source.pdf', digest: 'digest' },
    parser: { name: 'docling', contractVersion: 3, configFingerprint: 'config' },
    metadataCandidates: {}, metadataConfidence: {}, sourceRowCount: 1, sourceRowChecksum: checksumSourceRows([row]),
    reconciliation: { sourceTotal: 0, derivedTotal: 0, reconciled: true }, warnings: [], sections: [], totalItems: 0,
    aiReviewStatus: 'not_required', reviewTargeting: { candidateRowIds: [], candidateCount: 0, unreconciled: false },
  } as unknown as BoqExtractionRun
  const { db, records, wasApprovalInjected } = raceDb()

  await assert.rejects(
    () => createFirestoreReextractionPersistence(db as never, () => new Date('2026-07-20T01:00:00.000Z'))({ run, rows: [row] }),
    (error: unknown) => error instanceof ReextractError && error.code === 'read_only',
  )

  assert.equal(wasApprovalInjected(), true)
  assert.equal(records.get('boqs/boq-1')?.activeExtractionRunId, 'run-original')
  assert.equal(records.get('boqs/boq-1/extractionRuns/run-race')?.status, 'staging')
  assert.equal(records.has('boqs/boq-1/extractionRuns/run-race/sourceRows/row-1'), true)
})
