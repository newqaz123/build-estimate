import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq } from './boq-schema'
import type { DoclingResult } from './boq-ingestion'
import type { BoqExtractionRun } from './boq-extraction-run'
import { reextractBoqSource, ReextractError, type ReextractDependencies } from './boq-reextract'

const boq = {
  id: 'boq-1', project: 'Saved edit', vendor: 'Vendor', workType: 'MEP', date: '2026-07-20', totalItems: 1, grandTotal: 999,
  status: 'draft', stdStatus: 'none', sourceStoragePath: 'boqs/boq-1/source.pdf', sourceFileName: 'saved.pdf', activeExtractionRunId: 'run-original',
  sections: [{ header: 'Saved', items: [{ id: 'user-item', desc: 'User edit', unit: 'm', qty: 3, rate: 333, total: 999, type: 'unit', stdStatus: 'pending', entryOrigin: 'user' }] }],
} as unknown as Boq

const parsed = {
  contractVersion: 3,
  documentName: 'saved.pdf', pageCount: 1, documentText: 'Parsed', totalItems: 1,
  metadata: {
    vendor: { value: 'New vendor', confidence: 1 }, project: { value: 'Parsed project', confidence: 1 },
    workType: { value: 'MEP', confidence: 1 }, date: { value: '2026-07-20', confidence: 1 },
  },
  sections: [{ header: 'Parsed', items: [{ id: 'parsed-item', desc: 'Parsed', pricingRole: 'standard', sourceRowIds: ['row-1'], entryOrigin: 'docling', unit: 'm', qty: 1, rate: 10, total: 10, type: 'unit', costComponent: 'combined', stdStatus: 'pending' }] }],
  sourceRows: [{ id: 'row-1', page: 1, table: 1, row: 1, section: 'Parsed', headers: [], rawCells: ['Parsed'], rawText: 'Parsed', confidence: 1, warnings: [], classification: 'clear' }],
  warnings: [], reconciliation: { sourceTotal: 10, derivedTotal: 10, reconciled: true }, reviewTargeting: { candidateRowIds: [] },
} as unknown as DoclingResult

function dependencies(overrides: Partial<ReextractDependencies> = {}): ReextractDependencies {
  return {
    getBoq: async () => structuredClone(boq),
    loadSource: async () => new Uint8Array([1, 2, 3]),
    parsePdfWithDocling: async () => parsed,
    createRunId: () => 'run-reextracted',
    now: () => new Date('2026-07-20T10:00:00.000Z'),
    getEndpoint: async () => 'http://docling.test',
    persistRun: async (input) => ({ ...input.run, status: 'ready' } as BoqExtractionRun),
    ...overrides,
  }
}

test('re-extraction persists a new immutable run and discovers it without changing saved BOQ edits', async () => {
  let persisted: BoqExtractionRun | null = null
  const before = structuredClone(boq)
  const result = await reextractBoqSource('boq-1', dependencies({ persistRun: async ({ run }) => { persisted = run; return { ...run, status: 'ready' } } }))
  assert.deepEqual(result.canonicalBoq.sections, before.sections)
  assert.equal(result.canonicalBoq.project, before.project)
  assert.equal(result.canonicalBoq.vendor, before.vendor)
  assert.equal(result.canonicalBoq.activeExtractionRunId, 'run-reextracted')
  assert.equal(result.run.id, 'run-reextracted')
  assert.notEqual(result.run.id, before.activeExtractionRunId)
  assert.ok(persisted)
  assert.equal((persisted as BoqExtractionRun).boqId, 'boq-1')
})

test('re-extraction resolves the current workspace Docling endpoint before parsing', async () => {
  let parsedEndpoint = ''
  const result = await reextractBoqSource('boq-1', dependencies({
    getEndpoint: async () => 'http://docling-v3.test',
    parsePdfWithDocling: async (_file, endpoint) => {
      parsedEndpoint = endpoint
      return parsed
    },
  }))
  assert.equal(parsedEndpoint, 'http://docling-v3.test')
  assert.equal(result.run.parser.configFingerprint.length > 0, true)
})

test('re-extraction requires a retained source and a v3 parse without mutating canonical data', async () => {
  await assert.rejects(() => reextractBoqSource('boq-1', dependencies({ getBoq: async () => ({ ...boq, status: 'approved' }) })), (error: unknown) => error instanceof ReextractError && error.code === 'read_only')
  await assert.rejects(() => reextractBoqSource('boq-1', dependencies({ getBoq: async () => ({ ...boq, sourceStoragePath: undefined }) })), ReextractError)
  await assert.rejects(() => reextractBoqSource('boq-1', dependencies({ loadSource: async () => { throw new Error('storage unavailable') } })), (error: unknown) => error instanceof ReextractError && error.code === 'source_unavailable')
  await assert.rejects(() => reextractBoqSource('boq-1', dependencies({ parsePdfWithDocling: async () => ({ contractVersion: 2 } as DoclingResult) })), /v3/)
})

test('re-extraction preserves a typed read-only conflict raised during final persistence', async () => {
  await assert.rejects(
    () => reextractBoqSource('boq-1', dependencies({
      persistRun: async () => { throw new ReextractError('read_only') },
    })),
    (error: unknown) => error instanceof ReextractError && error.code === 'read_only',
  )
})
