import assert from 'node:assert/strict'
import test from 'node:test'
import type { Boq, BoqPricedItem, BoqSection } from './boq-schema'
import type { BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import {
  acceptExtractionProposal,
  rejectExtractionProposal,
  undoExtractionProposal,
  type ExtractionProposalAudit,
} from './boq-extraction-acceptance'
import { fingerprintCanonicalItem, type ExtractionProposal } from './boq-extraction-proposals'

const item: BoqPricedItem = { id: 'combined', desc: 'Pump supply and install', unit: 'set', qty: 1, rate: 100, total: 100, type: 'unit', costComponent: 'combined', stdStatus: 'pending', sourceRowId: 'row-1', sourceRowIds: ['row-1'], entryOrigin: 'docling' }
const sections: BoqSection[] = [{ header: 'Pumps', items: [item] }]
const boq = { id: 'boq-1', sections, totalItems: 1, grandTotal: 100, activeExtractionRunId: 'run-1' } as unknown as Boq
const run = { id: 'run-1', boqId: 'boq-1', status: 'ready', sections } as unknown as BoqExtractionRun
const rows = [{ id: 'row-1' }] as BoqSourceRowV3[]

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

test('duplicate acceptance returns the original audit without a second mutation', () => {
  const first = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(first.kind, 'accepted')
  if (first.kind !== 'accepted') return
  const retry = acceptExtractionProposal({ boq: first.boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:01:00.000Z', existingAudit: first.audit })
  assert.equal(retry.kind, 'already_accepted')
  if (retry.kind === 'already_accepted') assert.equal(retry.audit.auditId, first.audit.auditId)
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

test('undo restores exactly the recorded before state and refuses later edits', () => {
  const accepted = acceptExtractionProposal({ boq, run, sourceRows: rows, proposal: proposal(), actorId: 'user-1', now: '2026-07-20T10:00:00.000Z', existingAudit: null })
  assert.equal(accepted.kind, 'accepted')
  if (accepted.kind !== 'accepted') return
  const undone = undoExtractionProposal({ boq: accepted.boq, audit: accepted.audit, actorId: 'user-1', now: '2026-07-20T10:02:00.000Z' })
  assert.equal(undone.kind, 'undone')
  if (undone.kind === 'undone') assert.deepEqual(undone.boq.sections, sections)
  const changed = { ...accepted.boq, sections: [{ header: 'Pumps', items: [{ ...accepted.boq.sections[0].items[0], desc: 'User changed' }] }] }
  assert.equal(undoExtractionProposal({ boq: changed, audit: accepted.audit, actorId: 'user-1', now: '2026-07-20T10:02:00.000Z' }).kind, 'conflict')
})

void (null as unknown as ExtractionProposalAudit)
