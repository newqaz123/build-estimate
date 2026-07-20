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
import { fingerprintCanonicalItem, type ExtractionProposal, type ValidatedProposal } from './boq-extraction-proposals'

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
  transactionCount = 0
  collection(name: string): MemoryCollection { return new MemoryCollection(this, name) }
  doc(path: string): MemoryDoc { return new MemoryDoc(this, path) }
  async runTransaction<T>(callback: (transaction: MemoryTransaction) => Promise<T>): Promise<T> {
    this.transactionCount += 1
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

function keepProposal(id: string, sourceRowId: string, targetId: string, target: Boq['sections'][number]['items'][number]): ExtractionProposal {
  return {
    id, extractionRunId: 'run-1', operation: 'keep', sourceRowIds: [sourceRowId], targetItemIds: [targetId],
    affectedItemFingerprints: { [targetId]: fingerprintCanonicalItem(target) }, confidence: 0.95,
    explanation: 'Keep the validated deterministic row.', proposedItems: [],
  }
}

function proposal(): ExtractionProposal {
  return {
    id: 'proposal-1', extractionRunId: 'run-1', operation: 'separate_components', sourceRowIds: ['row-4'], targetItemIds: ['combined'],
    affectedItemFingerprints: {}, confidence: 0.95, explanation: 'Separate quoted components.',
    proposedItems: [
      { id: 'material', desc: 'Combined material', pricingRole: 'standard', sourceRowIds: ['row-4'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'material' },
      { id: 'labour', desc: 'Combined labour', pricingRole: 'standard', sourceRowIds: ['row-4'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 60, total: 60, costComponent: 'labour' },
    ],
  }
}

function harness(clock: () => Date = () => new Date('2026-07-20T12:00:00.000Z')) {
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
    store: createFirestoreExtractionProposalStore(db as never, clock),
    boq: db.docs.get('boqs/boq-1') as unknown as Boq,
    runPath,
    proposal: {
      ...proposal(), affectedItemFingerprints: { combined: fingerprintCanonicalItem(target) },
      evidenceValid: true, reconciled: true, stale: false,
    } as ValidatedProposal,
  }
}

test('store undo fences immutable evidence and replays exact accepted/undo BOQ snapshots', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  const firstAccept = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(firstAccept.status, 200)
  if (firstAccept.status !== 200) return
  const firstAcceptedBoq = firstAccept.body.boq

  const edited = fixture.db.docs.get('boqs/boq-1')!
  edited.project = 'User-edited project'
  edited.updatedAt = '2026-07-20T12:01:00.000Z'
  const acceptRetry = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')
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
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  fixture.db.docs.set('boqs/boq-1/extractionRuns/run-1/proposalAudits/proposal-1', {
    proposalId: 'proposal-1', status: 'accepted', targetItemIds: ['combined'],
  })
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  const result = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(result.status, 409)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
})

test('validated proposals persist durably and action status is reconstructed from audits', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  let state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.deepEqual(state?.proposals.map((entry) => entry.id), ['proposal-1'])
  assert.deepEqual(state?.proposalStatuses, { 'proposal-1': { status: 'pending', canUndo: false, stale: false, eligible: true } })

  const accepted = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(accepted.status, 200)
  state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.equal(state?.proposalStatuses['proposal-1']?.status, 'accepted')
  assert.equal(state?.proposalStatuses['proposal-1']?.canUndo, true)
  assert.equal(state?.auditEvents.length, 1)
})

test('single actions reload the stored proposal and reject approved BOQ mutation', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  fixture.db.docs.get('boqs/boq-1')!.status = 'approved'
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  const result = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(result.status, 409)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/proposal-1`), false)
})

test('approved BOQs also reject undo without changing the accepted audit', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  assert.equal((await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')).status, 200)
  fixture.db.docs.get('boqs/boq-1')!.status = 'approved'
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  const result = await fixture.store.undo('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(result.status, 409)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/proposal-1/events/undo`), false)
})

test('batch acceptance is one transaction and leaves BOQ and audits unchanged on any failure', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  const result = await fixture.store.acceptBatch('boq-1', 'run-1', ['proposal-1', 'missing'], 'user-1')
  assert.equal(result.status, 404)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/proposal-1`), false)
})

test('batch acceptance exposes undo only in LIFO order and advances eligibility after reload', async () => {
  const fixture = harness()
  const bundle = fixture.boq.sections.flatMap((section) => section.items).find((item) => item.id === 'bundle')!
  const option = fixture.boq.sections.flatMap((section) => section.items).find((item) => item.id === 'option')!
  const proposals = [
    keepProposal('keep-bundle', 'row-1', 'bundle', bundle),
    keepProposal('keep-option', 'row-3', 'option', option),
    fixture.proposal,
  ]
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', proposals as never)
  const beforeTransactions = fixture.db.transactionCount
  const result = await fixture.store.acceptBatch('boq-1', 'run-1', proposals.map((proposal) => proposal.id), 'user-1')
  assert.equal(result.status, 200)
  assert.equal(fixture.db.transactionCount - beforeTransactions, 1)
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/keep-bundle`), true)
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/keep-option`), true)
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/proposal-1`), true)

  let state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.deepEqual(Object.fromEntries(proposals.map((proposal) => [proposal.id, state?.proposalStatuses[proposal.id]?.canUndo])), {
    'keep-bundle': false, 'keep-option': false, 'proposal-1': true,
  })
  assert.equal((await fixture.store.undo('boq-1', 'run-1', 'proposal-1', 'user-1')).status, 200)
  state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.equal(state?.proposalStatuses['keep-option']?.canUndo, true)
  assert.equal(state?.proposalStatuses['keep-bundle']?.canUndo, false)
  assert.equal((await fixture.store.undo('boq-1', 'run-1', 'keep-option', 'user-1')).status, 200)
  state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.equal(state?.proposalStatuses['keep-bundle']?.canUndo, true)
})

test('a refreshed row supersedes old pending proposals and safely versions a reused model id', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  const refreshed = { ...fixture.proposal, explanation: 'Fresh evidence review.' }
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [refreshed])
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [refreshed])
  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.equal(state?.proposals.length, 1)
  assert.equal(state?.proposals[0]?.explanation, 'Fresh evidence review.')
  assert.notEqual(state?.proposals[0]?.id, 'proposal-1')
  const stored = [...fixture.db.docs.entries()].filter(([path]) => path.includes('/proposals/'))
  assert.equal(stored.length, 2)
  assert.equal(stored.filter(([, value]) => value.lifecycleStatus === 'superseded').length, 1)
})

test('a refreshed row with no new suggestion still supersedes its old pending proposals', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [], ['row-4'])
  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.deepEqual(state?.proposals, [])
  assert.equal(fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)?.lifecycleStatus, 'superseded')
})

test('refresh never supersedes an accepted legacy proposal whose lifecycle marker is absent', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')
  delete fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)!.lifecycleStatus
  const acceptedBoq = fixture.db.docs.get('boqs/boq-1') as unknown as Boq
  const material = acceptedBoq.sections[0]!.items.find((item) => item.id === 'material')!
  const refreshed = keepProposal('proposal-1', 'row-4', 'material', material)
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [{ ...refreshed, evidenceValid: true, reconciled: true, stale: false } as ValidatedProposal])
  assert.notEqual(fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)!.lifecycleStatus, 'superseded')
})

test('review reload recomputes pending staleness and disables unsafe eligibility', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  const canonical = fixture.db.docs.get('boqs/boq-1') as unknown as Boq
  canonical.sections[0]!.items.find((item) => item.id === 'combined')!.desc = 'User changed after review'
  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  const proposalId = state?.proposals[0]?.id ?? ''
  assert.equal(state?.proposals[0]?.stale, true)
  assert.deepEqual(state?.proposalStatuses[proposalId], { status: 'pending', canUndo: false, stale: true, eligible: false })
})

test('approved BOQs reject proposal rejection to keep review state immutable', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  fixture.db.docs.get('boqs/boq-1')!.status = 'approved'
  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  const proposalId = state?.proposals[0]?.id ?? ''
  const result = await fixture.store.reject('boq-1', 'run-1', proposalId, 'user-1')
  assert.equal(result.status, 409)
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/${proposalId}`), false)
})

test('review leases serialize dispatch, recover after expiry, and persist completion', async () => {
  let current = new Date('2026-07-20T12:00:00.000Z')
  const fixture = harness(() => current)
  const first = await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-1', 1_000, false)
  assert.equal(first.kind, 'acquired')
  const concurrent = await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-2', 1_000, false)
  assert.equal(concurrent.kind, 'busy')
  current = new Date('2026-07-20T12:00:02.000Z')
  const recovered = await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-3', 1_000, false)
  assert.equal(recovered.kind, 'acquired')
  await fixture.store.completeReviewLease('boq-1', 'run-1', 'lease-3', 'completed', [])
  assert.equal((fixture.db.docs.get(fixture.runPath)!.reviewRun as { status: string }).status, 'completed')
  assert.equal((await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-4', 1_000, false)).kind, 'complete')
})

test('late expired lease cannot persist or supersede proposals after the replacement lease completes', async () => {
  let current = new Date('2026-07-20T12:00:00.000Z')
  const fixture = harness(() => current)
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  const proposalB = { ...fixture.proposal, id: 'proposal-b', explanation: 'Replacement lease result.' }
  const proposalA = { ...fixture.proposal, id: 'proposal-a', explanation: 'Expired lease result.' }

  await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-a', 1_000, false)
  current = new Date('2026-07-20T12:00:02.000Z')
  await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-b', 1_000, false)
  await fixture.store.completeReviewLease('boq-1', 'run-1', 'lease-b', 'completed', [proposalB], ['row-4'])

  await assert.rejects(
    fixture.store.completeReviewLease('boq-1', 'run-1', 'lease-a', 'completed', [proposalA], ['row-4']),
    /lease was lost/,
  )

  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.deepEqual(state?.proposals.map((entry) => entry.id), ['proposal-b'])
  assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposals/proposal-a`), false)
  assert.equal(fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)?.lifecycleStatus, 'superseded')
  assert.equal((fixture.db.docs.get(fixture.runPath)?.reviewRun as { status?: string }).status, 'completed')
})

test('lease completion with zero proposals still atomically supersedes refreshed-row suggestions', async () => {
  const fixture = harness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])
  await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-1', 1_000, false)

  await fixture.store.completeReviewLease('boq-1', 'run-1', 'lease-1', 'completed', [], ['row-4'])

  assert.deepEqual((await fixture.store.getReviewState('boq-1', 'run-1'))?.proposals, [])
  assert.equal(fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)?.lifecycleStatus, 'superseded')
  assert.equal((fixture.db.docs.get(fixture.runPath)?.reviewRun as { status?: string }).status, 'completed')
})

test('review leases preserve reason-specific targeting through completion and reload', async () => {
  const fixture = harness()
  fixture.db.docs.get(fixture.runPath)!.reviewTargeting = {
    candidateRowIds: ['row-compound', 'row-ambiguous', 'row-unreconciled'], candidateCount: 3,
    ambiguousRowIds: ['row-ambiguous'], unreconciledRowIds: ['row-unreconciled'], unreconciled: true,
  }

  const acquired = await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-1', 1_000, false)
  assert.deepEqual(acquired.reviewRun.reviewTargeting, {
    candidateRowIds: ['row-compound', 'row-ambiguous', 'row-unreconciled'],
    ambiguousRowIds: ['row-ambiguous'], unreconciledRowIds: ['row-unreconciled'], unreconciled: true,
  })
  await fixture.store.completeReviewLease('boq-1', 'run-1', 'lease-1', 'completed', [])
  assert.deepEqual((await fixture.store.getReviewState('boq-1', 'run-1'))?.reviewRun.reviewTargeting, {
    candidateRowIds: ['row-compound', 'row-ambiguous', 'row-unreconciled'],
    ambiguousRowIds: ['row-ambiguous'], unreconciledRowIds: ['row-unreconciled'], unreconciled: true,
  })
})

test('durable review failure prevents immediate automatic retry but permits retry after backoff', async () => {
  let current = new Date('2026-07-20T12:00:00.000Z')
  const fixture = harness(() => current)
  await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-1', 1_000, false)
  await fixture.store.failReviewLease('boq-1', 'run-1', 'lease-1', 'timeout', 30_000)
  assert.equal((await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-2', 1_000, false)).kind, 'failed')
  current = new Date('2026-07-20T12:00:31.000Z')
  assert.equal((await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-3', 1_000, false)).kind, 'acquired')
})
