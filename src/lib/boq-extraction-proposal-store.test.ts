import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDraftImport, parseDoclingResult } from './boq-ingestion'
import {
  buildExtractionRun,
  extractionRunIdentityFingerprint,
  fingerprintParserConfig,
  stableSourceRowFingerprint,
} from './boq-extraction-run'
import { createFirestoreExtractionProposalStore } from './boq-extraction-proposal-store'
import { v3Fixture } from './boq-extraction-test-fixtures'
import type { Boq } from './boq-schema'
import { fingerprintCanonicalItem, type ExtractionProposal } from './boq-extraction-proposals'

type RecordData = Record<string, unknown>

interface MemoryTransaction {
  get(ref: MemoryDoc): Promise<MemorySnapshot>
  getAll(...refs: MemoryDoc[]): Promise<MemorySnapshot[]>
  create(ref: MemoryDoc, data: RecordData): void
  update(ref: MemoryDoc, data: RecordData): void
}

class MemorySnapshot {
  readonly exists: boolean
  readonly id: string
  constructor(private readonly ref: MemoryDoc, private readonly value: RecordData | undefined) {
    this.exists = value !== undefined
    this.id = ref.id
  }
  data(): RecordData | undefined { return this.value }
}

class MemoryDoc {
  constructor(private readonly db: MemoryDb, readonly path: string) {}
  get id(): string { return this.path.split('/').at(-1)! }
  async get(): Promise<MemorySnapshot> { return new MemorySnapshot(this, this.db.docs.get(this.path)) }
  collection(name: string): MemoryCollection { return new MemoryCollection(this.db, `${this.path}/${name}`) }
}

class MemoryCollection {
  constructor(private readonly db: MemoryDb, readonly path: string) {}
  doc(id: string): MemoryDoc { return new MemoryDoc(this.db, `${this.path}/${id}`) }
  orderBy(): this { return this }
  async get(): Promise<{ docs: MemorySnapshot[] }> {
    const prefix = `${this.path}/`
    const docs = [...this.db.docs.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, value]) => new MemorySnapshot(new MemoryDoc(this.db, path), value))
    return { docs }
  }
}

class MemoryDb {
  readonly docs = new Map<string, RecordData>()
  collection(name: string): MemoryCollection { return new MemoryCollection(this, name) }
  doc(path: string): MemoryDoc { return new MemoryDoc(this, path) }
  async runTransaction<T>(callback: (transaction: MemoryTransaction) => Promise<T>): Promise<T> {
    const writes: Array<{ kind: 'create' | 'update'; ref: MemoryDoc; data: RecordData }> = []
    const transaction = {
      get: async (ref: MemoryDoc) => ref.get(),
      getAll: async (...refs: MemoryDoc[]) => Promise.all(refs.map((ref) => ref.get())),
      create: (ref: MemoryDoc, data: RecordData) => writes.push({ kind: 'create', ref, data: structuredClone(data) }),
      update: (ref: MemoryDoc, data: RecordData) => writes.push({ kind: 'update', ref, data: structuredClone(data) }),
    }
    const result = await callback(transaction)
    for (const write of writes) {
      if (write.kind === 'create') {
        if (this.docs.has(write.ref.path)) throw new Error(`Document already exists: ${write.ref.path}`)
        this.docs.set(write.ref.path, write.data)
      } else {
        this.docs.set(write.ref.path, { ...(this.docs.get(write.ref.path) ?? {}), ...write.data })
      }
    }
    return result
  }
}

function proposal(): ExtractionProposal {
  return {
    id: 'proposal-1', extractionRunId: 'run-1', operation: 'split', sourceRowIds: ['row-4'], targetItemIds: ['combined'],
    affectedItemFingerprints: {}, confidence: 0.95, explanation: 'Separate quoted components.',
    proposedItems: [
      { id: 'material', desc: 'Combined material', pricingRole: 'standard', sourceRowIds: ['row-4'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'material' },
      { id: 'labour', desc: 'Combined labour', pricingRole: 'standard', sourceRowIds: ['row-4'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 60, total: 60, costComponent: 'labour' },
    ],
  }
}

function harness() {
  const parsed = parseDoclingResult(v3Fixture())
  if (parsed.contractVersion !== 3) throw new Error('Expected v3 fixture')
  const draft = buildDraftImport('boq-1', 'boqs/boq-1/source.pdf', parsed, 'run-1')
  const built = buildExtractionRun({ seed: draft.run!, sourceDigest: 'sha256:pdf', parserConfigFingerprint: 'sha256:config', now: new Date('2026-07-20T00:00:00.000Z') })
  const run = { ...built, status: 'ready' as const }
  const db = new MemoryDb()
  const runPath = 'boqs/boq-1/extractionRuns/run-1'
  const runMetadata = { ...run } as RecordData
  delete runMetadata.sections
  runMetadata.identityFingerprint = extractionRunIdentityFingerprint(run)
  runMetadata.deterministicSections = { checksum: fingerprintParserConfig(run.sections), reference: `${runPath}/sectionSnapshots`, chunkCount: 1 }
  db.docs.set(runPath, runMetadata)
  db.docs.set(`${runPath}/sectionSnapshots/000000`, { order: 0, sectionIndex: 0, sectionChunkIndex: 0, sections: run.sections })
  for (const row of parsed.sourceRows) db.docs.set(`${runPath}/sourceRows/${row.id}`, { ...row, fingerprint: stableSourceRowFingerprint(row) })
  db.docs.set('boqs/boq-1', {
    ...draft.boq,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  })
  const target = draft.boq.sections.flatMap((section) => section.items).find((item) => item.id === 'combined')!
  return {
    db,
    store: createFirestoreExtractionProposalStore(db as never, () => new Date('2026-07-20T12:00:00.000Z')),
    boq: db.docs.get('boqs/boq-1') as unknown as Boq,
    runPath,
    proposal: { ...proposal(), affectedItemFingerprints: { combined: fingerprintCanonicalItem(target) } },
  }
}

test('store undo fences immutable evidence and replays exact accepted/undo BOQ snapshots', async () => {
  const fixture = harness()
  const firstAccept = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', fixture.proposal, 'user-1')
  assert.equal(firstAccept.status, 200)
  if (firstAccept.status !== 200) return
  const firstAcceptedBoq = firstAccept.body.boq

  const edited = fixture.db.docs.get('boqs/boq-1')!
  edited.project = 'User-edited project'
  edited.updatedAt = '2026-07-20T12:01:00.000Z'
  const acceptRetry = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', fixture.proposal, 'user-1')
  assert.equal(acceptRetry.status, 200)
  if (acceptRetry.status !== 200) return
  assert.deepEqual(acceptRetry.body.boq, firstAcceptedBoq)
  assert.equal(fixture.db.docs.get('boqs/boq-1')!.project, 'User-edited project')

  const run = fixture.db.docs.get(fixture.runPath)! as { deterministicSections: { checksum: string } }
  run.deterministicSections.checksum = 'sha256:changed'
  const fencedUndo = await fixture.store.undo('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(fencedUndo.status, 409)
  const snapshot = fixture.db.docs.get(`${fixture.runPath}/sectionSnapshots/000000`)! as { sections: unknown }
  run.deterministicSections.checksum = fingerprintParserConfig(snapshot.sections)

  const firstUndo = await fixture.store.undo('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(firstUndo.status, 200)
  if (firstUndo.status !== 200) return
  const firstUndoneBoq = firstUndo.body.boq
  const undoPath = 'boqs/boq-1/extractionRuns/run-1/proposalAudits/proposal-1/events/undo'
  const undoEvent = fixture.db.docs.get(undoPath)!
  delete undoEvent.resultBoq
  const malformedRetry = await fixture.store.undo('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(malformedRetry.status, 409)
  undoEvent.resultBoq = structuredClone(firstUndoneBoq)
  fixture.db.docs.get('boqs/boq-1')!.project = 'Edited again'
  fixture.db.docs.get('boqs/boq-1')!.updatedAt = '2026-07-20T12:03:00.000Z'
  const undoRetry = await fixture.store.undo('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(undoRetry.status, 200)
  if (undoRetry.status !== 200) return
  assert.deepEqual(undoRetry.body.boq, firstUndoneBoq)
  assert.equal(fixture.db.docs.get('boqs/boq-1')!.project, 'Edited again')
})

test('store refuses malformed existing audit records before canonical mutation', async () => {
  const fixture = harness()
  fixture.db.docs.set('boqs/boq-1/extractionRuns/run-1/proposalAudits/proposal-1', {
    proposalId: 'proposal-1', status: 'accepted', targetItemIds: ['combined'],
  })
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  const result = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', fixture.proposal, 'user-1')
  assert.equal(result.status, 409)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
})
