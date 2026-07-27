import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildDraftImport, parseDoclingResult } from './boq-ingestion'
import {
  buildExtractionRun,
  checksumSourceRows,
  extractionRunIdentityFingerprint,
  fingerprintParserConfig,
  stableSourceRowFingerprint,
  type BoqExtractionRun,
} from './boq-extraction-run'
import { createFirestoreExtractionProposalStore } from './boq-extraction-proposal-store'
import { createFirestoreExtractionStore } from './boq-extraction-storage'
import { buildExtractionCandidates } from './boq-extraction-evidence'
import { prepareProviderProposalV2 } from './boq-extraction-proposal-contract'
import { v3Fixture } from './boq-extraction-test-fixtures'
import type { Boq, BoqPricedItem, BoqSection } from './boq-schema'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
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
    run,
    sourceRows: parsed.sourceRows,
    runPath,
    proposal: {
      ...proposal(), affectedItemFingerprints: { combined: fingerprintCanonicalItem(target) },
      evidenceValid: true, reconciled: true, stale: false,
    } as ValidatedProposal,
  }
}

function mappedStoreHarness() {
  const fixture = harness()
  const boq = fixture.db.docs.get('boqs/boq-1')! as unknown as Boq
  const sectionHeader = boq.sections[0].header
  const row: BoqSourceRowV3 = {
    id: 'mapped-row', page: 9, table: 1, row: 1, section: sectionHeader, headers: [],
    rawCells: [
      { column: 1, rawText: 'Mapped valve', lines: ['Mapped valve'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 1, endColumnOffset: 2, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
      { column: 2, rawText: 'pcs', lines: ['pcs'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 2, endColumnOffset: 3, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
      { column: 3, rawText: '2', lines: ['2'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 3, endColumnOffset: 4, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
      { column: 4, rawText: '50', lines: ['50'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 4, endColumnOffset: 5, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
      { column: 5, rawText: '100', lines: ['100'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 5, endColumnOffset: 6, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    ],
    rawText: 'Mapped valve | pcs | 2 | 50 | 100', classification: 'unknown', confidence: 0.96, warnings: [],
  }
  const sourceRows = [...fixture.sourceRows, row]
  const run = { ...fixture.run, sourceRowCount: sourceRows.length, sourceRowChecksum: checksumSourceRows(sourceRows) }
  const runRecord = fixture.db.docs.get(fixture.runPath)!
  runRecord.sourceRowCount = run.sourceRowCount
  runRecord.sourceRowChecksum = run.sourceRowChecksum
  runRecord.identityFingerprint = extractionRunIdentityFingerprint(run)
  fixture.db.docs.set(`${fixture.runPath}/sourceRows/${row.id}`, { ...row, fingerprint: stableSourceRowFingerprint(row) })
  const targetItems = new Map(boq.sections.flatMap((section) => section.items)
    .flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []))
  const decision = {
    id: 'mapped-store', operation: 'map_source_item', sourceRowIds: [row.id], targetItemIds: [], confidence: 0.96,
    explanation: 'Mapped from retained source cells.',
    cellMapping: {
      sourceRowIds: [row.id], description: [{ sourceRowId: row.id, column: 1 }],
      unit: { sourceRowId: row.id, column: 2 }, quantity: { sourceRowId: row.id, column: 3 },
      rate: { sourceRowId: row.id, column: 4 }, total: { sourceRowId: row.id, column: 5 },
    },
  }
  const context = {
    extractionRunId: run.id, sections: boq.sections, targetItems,
    candidateItems: buildExtractionCandidates(run, sourceRows), sourceRows, allowedSourceRowIds: new Set([row.id]),
  }
  return { ...fixture, boq, run, row, sourceRows, decision, context }
}

interface SurasakFixture {
  sourceRows: BoqSourceRowV3[]
  expectedSections: BoqExtractionRun['sections']
  expectedReconciliation: BoqExtractionRun['reconciliation']
}

function surasakHarness(clock: () => Date = () => new Date('2026-07-20T12:00:00.000Z')) {
  const fixture = JSON.parse(readFileSync(
    new URL('../../py-sidecar/fixtures/compound/surasak-unit-price.json', import.meta.url),
    'utf8',
  )) as SurasakFixture
  const run: BoqExtractionRun = {
    id: 'run-surasak', boqId: 'boq-surasak', contractVersion: 3, status: 'ready',
    createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z', stagingExpiresAt: null,
    sourceFile: { path: 'boqs/boq-surasak/source.pdf', name: 'surasak.pdf', digest: 'sha256:surasak' },
    parser: { name: 'docling', contractVersion: 3, configFingerprint: 'sha256:config' },
    metadataCandidates: {
      vendor: { value: 'SURASAK ENGINEERING CO.,LTD.', confidence: 1, source: 'fixture' },
      project: { value: 'MODIFY STAGE FLOOR', confidence: 1, source: 'fixture' },
      date: { value: '2026-01-15', confidence: 1, source: 'fixture' },
      workType: { value: 'MEP', confidence: 1, source: 'fixture' },
    },
    metadataConfidence: { vendor: 1, project: 1, date: 1, workType: 1 },
    sourceRowCount: fixture.sourceRows.length,
    sourceRowChecksum: checksumSourceRows(fixture.sourceRows),
    reconciliation: fixture.expectedReconciliation,
    warnings: [], sections: fixture.expectedSections, totalItems: 19,
    aiReviewStatus: 'queued',
    reviewTargeting: { candidateRowIds: [], candidateCount: 0, unreconciled: false },
  }
  const candidates = buildExtractionCandidates(run, fixture.sourceRows)
  const retainedIds = new Set([
    'di-sr-surasak-7-combined-1',
    'di-sr-surasak-8-combined-1',
    'di-sr-surasak-24-standard-1',
  ])
  const toCanonical = (candidate: ReturnType<typeof buildExtractionCandidates> extends Map<string, infer T> ? T : never): BoqPricedItem => ({
    id: candidate.id,
    desc: candidate.desc,
    pricingRole: 'standard',
    sourceRowId: candidate.sourceRowIds[0],
    sourceRowIds: [...candidate.sourceRowIds],
    sourceRef: candidate.sourceRefs[0],
    entryOrigin: 'docling',
    unit: candidate.unit,
    qty: candidate.qty,
    rate: candidate.rate,
    total: candidate.total,
    type: candidate.costComponent === 'lump_sum' ? 'lump_sum' : 'unit',
    costComponent: candidate.costComponent as BoqPricedItem['costComponent'],
    ...(candidate.sourceCosts ? {
      sourceCosts: {
        material: { ...candidate.sourceCosts.material, present: true as const },
        labour: { ...candidate.sourceCosts.labour, present: true as const },
      },
    } : {}),
    stdStatus: 'unmatched',
  })
  const staleSections: BoqSection[] = fixture.expectedSections.map((section) => ({
    header: section.header,
    items: section.items
      .filter((item) => retainedIds.has(item.id))
      .map((item) => toCanonical(candidates.get(item.id)!)),
  }))
  const staleTotal = staleSections.flatMap((section) => section.items)
    .reduce((sum, item) => sum + ('total' in item ? item.total : 0), 0)
  const boq: Boq = {
    id: 'boq-surasak', project: 'MODIFY STAGE FLOOR', vendor: 'SURASAK ENGINEERING CO.,LTD.',
    workType: 'MEP', date: '2026-01-15', status: 'draft', stdStatus: 'none', sections: staleSections,
    totalItems: 3, grandTotal: staleTotal, sourceTotal: 47000,
    sourceFileName: 'surasak.pdf', sourceStoragePath: 'boqs/boq-surasak/source.pdf',
    activeExtractionRunId: run.id, createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
  }
  const db = new MemoryDb()
  const runPath = 'boqs/boq-surasak/extractionRuns/run-surasak'
  const runMetadata = { ...run } as RecordData
  delete runMetadata.sections
  runMetadata.identityFingerprint = extractionRunIdentityFingerprint(run)
  runMetadata.deterministicSections = {
    checksum: fingerprintParserConfig(run.sections), reference: `${runPath}/sectionSnapshots`, chunkCount: run.sections.length,
  }
  db.docs.set(runPath, runMetadata)
  run.sections.forEach((section, sectionIndex) => {
    db.docs.set(`${runPath}/sectionSnapshots/${String(sectionIndex).padStart(6, '0')}`, {
      order: sectionIndex, sectionIndex, sectionChunkIndex: 0, sections: [section],
    })
  })
  for (const row of fixture.sourceRows) {
    db.docs.set(`${runPath}/sourceRows/${row.id}`, { ...row, fingerprint: stableSourceRowFingerprint(row) })
  }
  db.docs.set('boqs/boq-surasak', structuredClone(boq) as unknown as RecordData)
  return {
    db, run, runPath, sourceRows: fixture.sourceRows, candidates, staleSections,
    expectedSections: fixture.expectedSections,
    store: createFirestoreExtractionProposalStore(db as never, clock),
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
  assert.deepEqual(state?.proposalStatuses, { 'proposal-1': { status: 'pending', canUndo: false, stale: false, eligible: false } })

  const accepted = await fixture.store.accept('boq-1', 'run-1', 'proposal-1', 'user-1')
  assert.equal(accepted.status, 200)
  state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.equal(state?.proposalStatuses['proposal-1']?.status, 'accepted')
  assert.equal(state?.proposalStatuses['proposal-1']?.canUndo, true)
  assert.equal(state?.auditEvents.length, 1)
})

test('mapped proposal metadata persists, reloads, and is revalidated on acceptance', async () => {
  const fixture = mappedStoreHarness()
  const prepared = prepareProviderProposalV2(fixture.decision, fixture.context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const proposal = { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [proposal])
  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.deepEqual(state?.proposals[0].sourceCellMapping, proposal.sourceCellMapping)
  assert.deepEqual(state?.proposals[0].mappedCandidate, proposal.mappedCandidate)
  const result = await fixture.store.accept('boq-1', 'run-1', proposal.id, 'user-1')
  assert.equal(result.status, 200)
  assert.equal((fixture.db.docs.get('boqs/boq-1') as unknown as Boq).sections
    .flatMap((section) => section.items).some((item) => item.id === proposal.mappedCandidate?.id), true)
})

test('stored mapped candidate tampering is rejected before canonical mutation', async () => {
  const fixture = mappedStoreHarness()
  const prepared = prepareProviderProposalV2(fixture.decision, fixture.context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const proposal = { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [proposal])
  const path = `${fixture.runPath}/proposals/${proposal.id}`
  const stored = fixture.db.docs.get(path)! as { proposal: typeof proposal }
  stored.proposal.mappedCandidate = { ...stored.proposal.mappedCandidate!, total: 999 }
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  const result = await fixture.store.accept('boq-1', 'run-1', proposal.id, 'user-1')
  assert.equal(result.status, 404)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
})

test('source-backed review draft persists but remains non-acceptable', async () => {
  const fixture = mappedStoreHarness()
  const incomplete = {
    ...fixture.decision,
    cellMapping: {
      sourceRowIds: ['mapped-row'], description: [{ sourceRowId: 'mapped-row', column: 1 }],
      unit: { sourceRowId: 'mapped-row', column: 2 }, quantity: { sourceRowId: 'mapped-row', column: 3 },
    },
  }
  const prepared = prepareProviderProposalV2(incomplete, fixture.context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const proposal = { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [proposal])
  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  assert.deepEqual(state?.proposals[0].reviewDraft, proposal.reviewDraft)
  assert.equal((await fixture.store.accept('boq-1', 'run-1', proposal.id, 'user-1')).status, 400)
})

test('store reload and acceptance reject mapped provenance with an unused declared row', async () => {
  const fixture = mappedStoreHarness()
  const prepared = prepareProviderProposalV2(fixture.decision, fixture.context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const proposal = { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [proposal])
  const path = `${fixture.runPath}/proposals/${proposal.id}`
  const stored = fixture.db.docs.get(path)! as { proposal: typeof proposal }
  stored.proposal.sourceRowIds = ['mapped-row', fixture.sourceRows[0].id]
  stored.proposal.sourceCellMapping = {
    ...stored.proposal.sourceCellMapping!,
    sourceRowIds: ['mapped-row', fixture.sourceRows[0].id],
  }
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  await assert.rejects(() => fixture.store.getReviewState('boq-1', 'run-1'), /Stored proposal record is invalid/)
  assert.equal((await fixture.store.accept('boq-1', 'run-1', proposal.id, 'user-1')).status, 404)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
})

test('store reload rejects malformed source-backed mapping and candidate metadata', async () => {
  for (const mutate of [
    (proposal: Record<string, unknown>) => {
      const mapping = proposal.sourceCellMapping as { unit: Record<string, unknown> }
      mapping.unit.column = 'bad'
    },
    (proposal: Record<string, unknown>) => {
      const candidate = proposal.mappedCandidate as Record<string, unknown>
      candidate.total = '100'
    },
  ]) {
    const fixture = mappedStoreHarness()
    const prepared = prepareProviderProposalV2(fixture.decision, fixture.context)
    assert.equal(prepared.ok, true)
    if (!prepared.ok) continue
    const proposal = { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
    await fixture.store.saveValidatedProposals('boq-1', 'run-1', [proposal])
    const stored = fixture.db.docs.get(`${fixture.runPath}/proposals/${proposal.id}`)! as { proposal: Record<string, unknown> }
    mutate(stored.proposal)
    await assert.rejects(() => fixture.store.getReviewState('boq-1', 'run-1'), /Stored proposal record is invalid/)
  }
})

test('store reload rejects malformed source-backed review draft metadata', async () => {
  const fixture = mappedStoreHarness()
  const prepared = prepareProviderProposalV2({
    ...fixture.decision,
    cellMapping: {
      sourceRowIds: ['mapped-row'], description: [{ sourceRowId: 'mapped-row', column: 1 }],
      unit: { sourceRowId: 'mapped-row', column: 2 }, quantity: { sourceRowId: 'mapped-row', column: 3 },
    },
  }, fixture.context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const proposal = { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [proposal])
  const stored = fixture.db.docs.get(`${fixture.runPath}/proposals/${proposal.id}`)! as {
    proposal: { reviewDraft: { missingFields: string[] } }
  }
  stored.proposal.reviewDraft.missingFields = ['provider-authored-field']
  await assert.rejects(() => fixture.store.getReviewState('boq-1', 'run-1'), /Stored proposal record is invalid/)
})

test('store reload rejects unexpected proposal fields instead of exposing stored provider data', async () => {
  const fixture = mappedStoreHarness()
  const prepared = prepareProviderProposalV2(fixture.decision, fixture.context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const proposal = { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [proposal])
  const stored = fixture.db.docs.get(`${fixture.runPath}/proposals/${proposal.id}`)! as {
    proposal: Record<string, unknown>
  }
  stored.proposal.providerResponse = { text: 'must not reach the client' }
  await assert.rejects(() => fixture.store.getReviewState('boq-1', 'run-1'), /Stored proposal record is invalid/)
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

test('batch acceptance atomically restores multiple targetless source-backed inserts in source order', async () => {
  const fixture = harness()
  const candidates = buildExtractionCandidates(fixture.run, fixture.sourceRows)
  const missing = [...candidates.values()].filter((candidate) => candidate.pricingRole === 'standard').slice(0, 2)
  assert.equal(missing.length, 2)
  const boqRecord = fixture.db.docs.get('boqs/boq-1')! as unknown as Boq
  const missingIds = new Set(missing.map((candidate) => candidate.id))
  boqRecord.sections = boqRecord.sections.map((section) => ({
    ...section, items: section.items.filter((item) => !missingIds.has(item.id ?? '')),
  }))
  const targetItems = new Map(boqRecord.sections.flatMap((section) => section.items)
    .flatMap((item) => item.id ? [[item.id, item] as const] : []))
  const proposals = missing.map((candidate, index) => {
    const prepared = prepareProviderProposalV2({
      id: `insert-${index}`, operation: 'insert_missing_item', sourceRowIds: candidate.sourceRowIds,
      targetItemIds: [], candidateItemIds: [candidate.id], confidence: 0.95,
      explanation: 'Restore immutable source candidate.',
    }, { extractionRunId: fixture.run.id, sections: boqRecord.sections, targetItems, candidateItems: candidates })
    assert.equal(prepared.ok, true)
    if (!prepared.ok) throw new Error('Preparation failed')
    return { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  })
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', proposals)
  const beforeTransactions = fixture.db.transactionCount
  const result = await fixture.store.acceptBatch('boq-1', 'run-1', proposals.map((proposal) => proposal.id), 'user-1')
  assert.equal(result.status, 200)
  assert.equal(fixture.db.transactionCount - beforeTransactions, 1)
  const restored = fixture.db.docs.get('boqs/boq-1')! as unknown as Boq
  const restoredIds = restored.sections.flatMap((section) => section.items).map((item) => item.id)
  for (const candidate of missing) assert.equal(restoredIds.includes(candidate.id), true)
  assert.ok(restoredIds.indexOf(missing[0].id) < restoredIds.indexOf(missing[1].id))
})

test('Surasak stale 3-item draft atomically accepts 16 inserts into 19 source-ordered items totaling 47,000', async () => {
  const fixture = surasakHarness()
  const canonicalSourceRows = new Set(fixture.staleSections.flatMap((section) => section.items)
    .flatMap((item) => item.sourceRowIds ?? []))
  const missing = [...fixture.candidates.values()]
    .filter((candidate) => !candidate.sourceRowIds.some((id) => canonicalSourceRows.has(id)))
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
  assert.equal(missing.length, 16)
  const current = fixture.db.docs.get('boqs/boq-surasak')! as unknown as Boq
  const targetItems = new Map(current.sections.flatMap((section) => section.items)
    .flatMap((item) => item.id ? [[item.id, item] as const] : []))
  const proposals = missing.map((candidate, index) => {
    const prepared = prepareProviderProposalV2({
      id: `insert-surasak-${index + 1}`,
      operation: 'insert_missing_item',
      sourceRowIds: candidate.sourceRowIds,
      targetItemIds: [],
      candidateItemIds: [candidate.id],
      confidence: 0.99,
      explanation: 'Restore immutable source-backed quotation row.',
    }, {
      extractionRunId: fixture.run.id,
      sections: current.sections,
      targetItems,
      candidateItems: fixture.candidates,
    })
    assert.equal(prepared.ok, true)
    if (!prepared.ok) throw new Error('Surasak proposal preparation failed')
    return { ...prepared.proposal, evidenceValid: true as const, reconciled: true as const, stale: false }
  })
  const immutableStore = createFirestoreExtractionStore(fixture.db as never)
  const loaded = await immutableStore.getReadyImport('boq-surasak', fixture.run.id)
  assert.ok(loaded)
  assert.equal(extractionRunIdentityFingerprint(loaded.run), extractionRunIdentityFingerprint(fixture.run))
  assert.equal(fingerprintParserConfig(loaded.run.sections), fingerprintParserConfig(fixture.run.sections))
  assert.equal((await immutableStore.getSourceRows('boq-surasak', fixture.run.id)).length, fixture.sourceRows.length)
  await fixture.store.saveValidatedProposals('boq-surasak', fixture.run.id, proposals)
  const transactionsBefore = fixture.db.transactionCount
  const result = await fixture.store.acceptBatch(
    'boq-surasak', fixture.run.id, proposals.map((proposal) => proposal.id), 'user-1',
  )
  assert.equal(result.status, 200)
  assert.equal(fixture.db.transactionCount - transactionsBefore, 1)
  const accepted = fixture.db.docs.get('boqs/boq-surasak')! as unknown as Boq
  assert.equal(accepted.totalItems, 19)
  assert.equal(accepted.grandTotal, 47000)
  assert.deepEqual(
    accepted.sections.flatMap((section) => section.items).map((item) => item.id),
    fixture.expectedSections.flatMap((section) => section.items).map((item) => item.id),
  )
  for (const id of ['di-sr-surasak-7-combined-1', 'di-sr-surasak-8-combined-1']) {
    const combined = accepted.sections.flatMap((section) => section.items).find((item) => item.id === id) as BoqPricedItem
    assert.equal(combined.costComponent, 'combined')
    assert.ok(combined.sourceCosts)
  }
  for (const proposal of proposals) {
    const audit = fixture.db.docs.get(`${fixture.runPath}/proposalAudits/${proposal.id}`)!
    assert.equal(Array.isArray(audit.beforeSections), true)
    assert.equal(Array.isArray(audit.afterSections), true)
    assert.equal((audit.batchProposalIds as string[]).length, 16)
    assert.equal((audit.resultBoq as Boq).totalItems, 19)
    assert.equal((audit.resultBoq as Boq).grandTotal, 47000)
  }
  const beforeUnsafeUndo = structuredClone(fixture.db.docs.get('boqs/boq-surasak'))
  const undo = await fixture.store.undo('boq-surasak', fixture.run.id, proposals[0].id, 'user-1')
  assert.equal(undo.status, 409)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-surasak'), beforeUnsafeUndo)
})

test('batch acceptance rejects legacy no-op and restructuring proposals', async () => {
  const fixture = harness()
  const bundle = fixture.boq.sections.flatMap((section) => section.items).find((item) => item.id === 'bundle')!
  const option = fixture.boq.sections.flatMap((section) => section.items).find((item) => item.id === 'option')!
  const proposals = [
    keepProposal('keep-bundle', 'row-1', 'bundle', bundle),
    keepProposal('keep-option', 'row-3', 'option', option),
    fixture.proposal,
  ]
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', proposals as never)
  const before = structuredClone(fixture.db.docs.get('boqs/boq-1'))
  const result = await fixture.store.acceptBatch('boq-1', 'run-1', proposals.map((proposal) => proposal.id), 'user-1')
  assert.equal(result.status, 400)
  assert.deepEqual(fixture.db.docs.get('boqs/boq-1'), before)
  for (const proposal of proposals) assert.equal(fixture.db.docs.has(`${fixture.runPath}/proposalAudits/${proposal.id}`), false)
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

test('review lease completion durably unions rows reviewed without proposals', async () => {
  const fixture = harness()
  await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-1', 'lease-1', 1_000, false)
  await fixture.store.completeReviewLease('boq-1', 'run-1', 'lease-1', 'completed', [], ['row-4'])
  await fixture.store.acquireReviewLease('boq-1', 'run-1', 'request-2', 'lease-2', 1_000, true)
  await fixture.store.completeReviewLease('boq-1', 'run-1', 'lease-2', 'completed', [], ['row-5'])

  assert.deepEqual((await fixture.store.getReviewState('boq-1', 'run-1'))?.reviewRun.reviewedSourceRowIds, ['row-4', 'row-5'])
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

test('reviewRun summary omits unexpected stored fields that could leak provider payloads or source data', async () => {
  const fixture = harness()
  const runRecord = fixture.db.docs.get(fixture.runPath) as RecordData
  runRecord.reviewRun = {
    status: 'completed',
    updatedAt: '2026-07-20T12:00:00.000Z',
    reviewedSourceRowIds: ['row-1'],
    rawProviderResponse: { choices: [{ message: { content: 'LEAK' } }] },
    sourceDataBlob: 'private-source',
    internalDebugTrace: ['sensitive-trace'],
  }
  runRecord.aiReviewStatus = 'completed'

  const state = await fixture.store.getReviewState('boq-1', 'run-1')
  const summary = state?.reviewRun as unknown as Record<string, unknown>
  assert.equal(summary?.status, 'completed')
  assert.deepEqual(summary?.reviewedSourceRowIds, ['row-1'])
  assert.equal(summary?.rawProviderResponse, undefined)
  assert.equal(summary?.sourceDataBlob, undefined)
  assert.equal(summary?.internalDebugTrace, undefined)
})
