import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq, BoqPricedItem, BoqSection } from './boq-schema'
import type { BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import {
  acceptExtractionProposal,
  proposalMatchesAudit,
  rejectExtractionProposal,
  undoExtractionProposal,
  type ExtractionProposalAudit,
} from './boq-extraction-acceptance'
import { fingerprintCanonicalItem, type ExtractionProposal } from './boq-extraction-proposals'
import { prepareProviderProposalV2 } from './boq-extraction-proposal-contract'

const item: BoqPricedItem = { id: 'combined', desc: 'Pump supply and install', unit: 'set', qty: 1, rate: 100, total: 100, type: 'unit', costComponent: 'combined', stdStatus: 'pending', sourceRowId: 'row-1', sourceRowIds: ['row-1'], entryOrigin: 'docling' }
const sections: BoqSection[] = [{ header: 'Pumps', items: [item] }]
const boq = { id: 'boq-1', sections, totalItems: 1, grandTotal: 100, activeExtractionRunId: 'run-1' } as unknown as Boq
const run = { id: 'run-1', boqId: 'boq-1', status: 'ready', sections } as unknown as BoqExtractionRun
const rows = [{ id: 'row-1' }] as BoqSourceRowV3[]

const mappedRow: BoqSourceRowV3 = {
  id: 'mapped-row', page: 2, table: 1, row: 3, section: 'Works', headers: [],
  rawCells: [
    { column: 1, rawText: 'Mapped valve', lines: ['Mapped valve'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 1, endColumnOffset: 2, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 2, rawText: 'pcs', lines: ['pcs'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 2, endColumnOffset: 3, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 3, rawText: '2', lines: ['2'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 3, endColumnOffset: 4, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 4, rawText: '50', lines: ['50'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 4, endColumnOffset: 5, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 5, rawText: '100', lines: ['100'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 5, endColumnOffset: 6, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
  ],
  rawText: 'Mapped valve | pcs | 2 | 50 | 100', classification: 'unknown', confidence: 0.96, warnings: [],
}

const mappedBoq = { id: 'boq-mapped', sections: [{ header: 'Works', items: [] }], totalItems: 0, grandTotal: 0 } as unknown as Boq
const mappedRun = { id: 'run-mapped', boqId: 'boq-mapped', status: 'ready', sections: [] } as unknown as BoqExtractionRun

function mappedProposal(input: { boq?: Boq; row?: BoqSourceRowV3; targetItemIds?: string[] } = {}) {
  const currentBoq = input.boq ?? mappedBoq
  const sourceRow = input.row ?? mappedRow
  const targetItems = new Map(currentBoq.sections.flatMap((section) => section.items)
    .flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []))
  const prepared = prepareProviderProposalV2({
    id: 'mapped-proposal', operation: 'map_source_item', sourceRowIds: ['mapped-row'], targetItemIds: input.targetItemIds ?? [],
    confidence: 0.96, explanation: 'Mapped from retained source cells.',
    cellMapping: {
      sourceRowIds: ['mapped-row'],
      description: [{ sourceRowId: 'mapped-row', column: 1 }],
      unit: { sourceRowId: 'mapped-row', column: 2 }, quantity: { sourceRowId: 'mapped-row', column: 3 },
      rate: { sourceRowId: 'mapped-row', column: 4 }, total: { sourceRowId: 'mapped-row', column: 5 },
    },
  }, {
    extractionRunId: 'run-mapped', sections: currentBoq.sections, targetItems, candidateItems: new Map(),
    sourceRows: [sourceRow], allowedSourceRowIds: new Set(['mapped-row']),
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) throw new Error('Mapped proposal preparation failed')
  return prepared.proposal
}

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  return {
    id: 'proposal-1', extractionRunId: 'run-1', operation: 'split', sourceRowIds: ['row-1'], targetItemIds: ['combined'],
    affectedItemFingerprints: { combined: fingerprintCanonicalItem(item) }, confidence: 0.95, explanation: 'Two quoted components.',
    proposedItems: [
      { id: 'material', desc: 'Pump material', pricingRole: 'standard', sourceRowIds: ['row-1'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 60, total: 60, costComponent: 'combined' },
      { id: 'labour', desc: 'Pump labour', pricingRole: 'standard', sourceRowIds: ['row-1'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'combined' },
    ],
    ...overrides,
  }
}

test('explicit acceptance validates, preserves audit evidence, and excludes bundle children from totals', () => {
  const result = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(result.kind, 'accepted')
  if (result.kind !== 'accepted') return
  assert.deepEqual(result.boq.sections[0].items.map((entry) => entry.id), ['material', 'labour'])
  assert.equal(result.boq.grandTotal, 100)
  assert.equal(result.audit.actorId, 'user-1')
  assert.deepEqual(result.audit.sourceRowIds, ['row-1'])
  assert.equal(result.audit.beforeSections[0].items[0].id, 'combined')
  assert.equal(result.audit.afterSections[0].items[0].id, 'material')
})

test('duplicate acceptance replays the exact recorded BOQ snapshot after canonical metadata changes', () => {
  const first = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(first.kind, 'accepted')
  if (first.kind !== 'accepted') return
  const retry = acceptExtractionProposal({
    boq: { ...first.boq, project: 'User-edited project', updatedAt: '2026-07-20T10:01:00.000Z' },
    run,
    sourceRows: rows,
    proposal: proposal(),
    actorId: 'user-1',
    now: '2026-07-20T10:01:00.000Z',
    existingAudit: first.audit,
  })
  assert.equal(retry.kind, 'already_accepted')
  if (retry.kind === 'already_accepted') {
    assert.equal(retry.audit.auditId, first.audit.auditId)
    assert.deepEqual(retry.boq, first.boq)
  }
})

test('accepted replay fails closed when its result snapshot is unavailable', () => {
  const first = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(first.kind, 'accepted')
  if (first.kind !== 'accepted') return
  const legacyAudit = structuredClone(first.audit)
  delete legacyAudit.resultBoq
  const retry = acceptExtractionProposal({ boq: first.boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:01:00.000Z', existingAudit: legacyAudit })
  assert.equal(retry.kind, 'invalid')
})

test('proposal replay identity includes proposed items and validation evidence state', () => {
  const first = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(first.kind, 'accepted')
  if (first.kind !== 'accepted') return
  const alteredItems = proposal({ proposedItems: proposal().proposedItems.map((item) => ({ ...item, desc: `${item.desc} (altered)` })) })
  assert.equal(proposalMatchesAudit(alteredItems, first.audit), false)
  const validated = Object.assign(proposal(), { evidenceValid: true, reconciled: true, stale: false })
  const acceptedWithValidated = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: validated, actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(acceptedWithValidated.kind, 'accepted')
  if (acceptedWithValidated.kind !== 'accepted') return
  assert.equal(proposalMatchesAudit(Object.assign(proposal(), { evidenceValid: true, reconciled: false, stale: false }), acceptedWithValidated.audit), false)
})

test('stale, unknown, and rejected proposals cannot mutate canonical sections', () => {
  const stale = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal({ affectedItemFingerprints: { combined: 'wrong' } }), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(stale.kind, 'invalid')
  const rejected = rejectExtractionProposal({ proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(rejected.kind, 'rejected')
  if (rejected.kind !== 'rejected') return
  const accepted = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:01:00.000Z', existingAudit: rejected.audit })
  assert.equal(accepted.kind, 'rejected')
})

test('rejected proposal retries enforce the recorded proposal payload', () => {
  const rejected = rejectExtractionProposal({ proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(rejected.kind, 'rejected')
  if (rejected.kind !== 'rejected') return
  const altered = rejectExtractionProposal({
    proposal: proposal({ proposedItems: proposal().proposedItems.map((item) => ({ ...item, desc: `${item.desc} (altered)` })) }),
    actorId: 'user-1',
    now: '2026-07-20T10:01:00.000Z',
    existingAudit: rejected.audit,
  })
  assert.equal(altered.kind, 'invalid')
})

test('undo restores exactly the recorded before state and refuses later edits', () => {
  const accepted = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(accepted.kind, 'accepted')
  if (accepted.kind !== 'accepted') return
  const undone = undoExtractionProposal({ boq: accepted.boq, audit: accepted.audit, actorId: 'user-1', now: '2026-07-20T10:02:00.000Z' })
  assert.equal(undone.kind, 'undone')
  if (undone.kind === 'undone') {
    assert.deepEqual(undone.boq.sections, sections)
    assert.equal(undone.audit.status, 'undone')
    assert.equal(accepted.audit.status, 'accepted')
    assert.notEqual(undone.audit.eventId, accepted.audit.auditId)
  }
  const changed = { ...accepted.boq, sections: [{ header: 'Pumps', items: [{ ...accepted.boq.sections[0].items[0], desc: 'User changed' }] }] }
  assert.equal(undoExtractionProposal({ boq: changed, audit: accepted.audit, actorId: 'user-1', now: '2026-07-20T10:02:00.000Z' }).kind, 'conflict')
})

void (null as unknown as ExtractionProposalAudit)

test('mapped proposal is reconstructed from immutable cells before acceptance and audited canonically', () => {
  const proposal = mappedProposal()
  const result = acceptExtractionProposal({
    boq: mappedBoq, run: mappedRun, sourceRows: [mappedRow], proposal,
    actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null,
  })
  assert.equal(result.kind, 'accepted')
  if (result.kind !== 'accepted') return
  assert.equal((result.boq.sections[0].items[0] as BoqPricedItem).total, 100)
  assert.deepEqual(result.audit.sourceCellMapping, proposal.sourceCellMapping)
  assert.deepEqual(result.audit.mappedCandidate, proposal.mappedCandidate)
  assert.equal(proposalMatchesAudit(proposal, result.audit), true)
})

test('mapped acceptance fails closed for mapping, candidate, source evidence, section, and revision tampering', () => {
  const canonical = mappedProposal()
  const attempts: Array<{ boq?: Boq; rows?: BoqSourceRowV3[]; proposal: typeof canonical }> = [
    { proposal: { ...canonical, sourceCellMapping: { ...canonical.sourceCellMapping!, total: { sourceRowId: 'mapped-row', column: 4 } } } },
    { proposal: { ...canonical, mappedCandidate: { ...canonical.mappedCandidate!, total: 101 } } },
    { rows: [{ ...mappedRow, rawCells: mappedRow.rawCells.map((cell) => cell.column === 5 ? { ...cell, rawText: '120', lines: ['120'] } : cell) }], proposal: canonical },
    { proposal: { ...canonical, destinationSectionIndex: 1 } },
    { boq: { ...mappedBoq, sections: [{ header: 'Changed', items: [] }] }, proposal: canonical },
  ]
  for (const attempt of attempts) {
    const result = acceptExtractionProposal({
      boq: attempt.boq ?? mappedBoq, run: mappedRun, sourceRows: attempt.rows ?? [mappedRow], proposal: attempt.proposal,
      actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null,
    })
    assert.equal(result.kind, 'invalid')
  }
})

test('mapped excluded replacement re-derives target state during acceptance', () => {
  const target: BoqPricedItem = {
    id: 'target', desc: 'Old valve', unit: 'pcs', qty: 2, rate: 50, total: 100, type: 'unit',
    costComponent: 'combined', stdStatus: 'pending', sourceRowId: 'mapped-row', sourceRowIds: ['mapped-row'], entryOrigin: 'docling',
    optional: true, excludedFromTotal: true, exclusionReason: 'Client option',
  }
  const replacementBoq = { ...mappedBoq, sections: [{ header: 'Works', items: [target] }], totalItems: 1 }
  const proposal = mappedProposal({ boq: replacementBoq, targetItemIds: ['target'] })
  const result = acceptExtractionProposal({
    boq: replacementBoq, run: mappedRun, sourceRows: [mappedRow], proposal,
    actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null,
  })
  assert.equal(result.kind, 'accepted')
  if (result.kind !== 'accepted') return
  assert.deepEqual({
    optional: result.boq.sections[0].items[0].optional,
    excludedFromTotal: result.boq.sections[0].items[0].excludedFromTotal,
    exclusionReason: result.boq.sections[0].items[0].exclusionReason,
  }, { optional: true, excludedFromTotal: true, exclusionReason: 'Client option' })
})
