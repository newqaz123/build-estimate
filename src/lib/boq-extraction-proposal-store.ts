import type { Firestore } from 'firebase-admin/firestore'
import type { Boq } from './boq-schema'
import { extractionRunPath, sourceRowPath, createFirestoreExtractionStore } from './boq-extraction-storage'
import { checksumSourceRows, extractionRunIdentityFingerprint, fingerprintParserConfig, type BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import type { ExtractionProposal } from './boq-extraction-proposals'
import {
  acceptExtractionProposal,
  proposalMatchesAudit,
  rejectExtractionProposal,
  undoExtractionProposal,
  validateExtractionProposal,
  type ExtractionProposalAudit,
  type ExtractionProposalUndoEvent,
} from './boq-extraction-acceptance'

export type ProposalStoreResponse =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409 | 500; body: { error: string } }

function auditPath(boqId: string, runId: string, proposalId: string): string {
  return `${extractionRunPath(boqId, runId)}/proposalAudits/${proposalId}`
}

function isAudit(value: unknown): value is ExtractionProposalAudit {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ExtractionProposalAudit).proposalId === 'string'
    && ((value as ExtractionProposalAudit).status === 'accepted' || (value as ExtractionProposalAudit).status === 'rejected')
    && Array.isArray((value as ExtractionProposalAudit).targetItemIds)
    && ((value as ExtractionProposalAudit).status === 'rejected' || isBoqSnapshot((value as ExtractionProposalAudit).resultBoq))
}

function isUndoEvent(value: unknown): value is ExtractionProposalUndoEvent {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ExtractionProposalUndoEvent).eventId === 'string'
    && (value as ExtractionProposalUndoEvent).status === 'undone'
    && Array.isArray((value as ExtractionProposalUndoEvent).afterSections)
    && isBoqSnapshot((value as ExtractionProposalUndoEvent).resultBoq)
}

function isBoqSnapshot(value: unknown): value is Boq {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray((value as Boq).sections)
    && typeof (value as Boq).totalItems === 'number'
    && typeof (value as Boq).grandTotal === 'number'
}

function invalidResponse(code: string): ProposalStoreResponse {
  const status = code === 'stale_item' ? 409 : 400
  return { status, body: { error: code } }
}

function rowWithoutFingerprint(snapshot: FirebaseFirestore.DocumentSnapshot): BoqSourceRowV3 {
  const data = { ...snapshot.data() }
  delete data.fingerprint
  return data as unknown as BoqSourceRowV3
}

async function verifyImmutableContext(
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  boqId: string,
  runId: string,
  storedRun: FirebaseFirestore.DocumentSnapshot,
  immutable: { run: BoqExtractionRun; sourceRows: BoqSourceRowV3[] },
): Promise<boolean> {
  const data = storedRun.data()
  if (!storedRun.exists || data?.status !== 'ready'
    || data.id !== runId
    || data.boqId !== boqId
    || immutable.run.id !== runId
    || immutable.run.boqId !== boqId) return false
  if (data.identityFingerprint !== extractionRunIdentityFingerprint(immutable.run)
    || data.sourceRowCount !== immutable.run.sourceRowCount
    || data.sourceRowChecksum !== immutable.run.sourceRowChecksum
    || data.deterministicSections?.checksum !== fingerprintParserConfig(immutable.run.sections)) return false
  const refs = immutable.sourceRows.map((row) => db.doc(sourceRowPath(boqId, runId, row.id)))
  const snapshots = refs.length > 0 ? await transaction.getAll(...refs) : []
  if (snapshots.length !== immutable.sourceRows.length || snapshots.some((snapshot) => !snapshot.exists)) return false
  const rows = snapshots.map(rowWithoutFingerprint)
  return rows.length === data.sourceRowCount && checksumSourceRows(rows) === data.sourceRowChecksum
}

function auditIdentityValid(proposal: ExtractionProposal, audit: ExtractionProposalAudit): boolean {
  return isAudit(audit) && proposalMatchesAudit(proposal, audit)
}

/**
 * Firestore action store. The canonical BOQ write and audit record write occur
 * in the same transaction. Source rows/run sections are immutable once ready.
 */
export function createFirestoreExtractionProposalStore(db: Firestore, now: () => Date = () => new Date()) {
  const evidence = createFirestoreExtractionStore(db)

  async function loadImmutable(boqId: string, runId: string) {
    const imported = await evidence.getReadyImport(boqId, runId)
    if (!imported) return null
    const sourceRows = await evidence.getSourceRows(boqId, runId)
    return { ...imported, sourceRows }
  }

  return {
    async accept(boqId: string, runId: string, proposalId: string, proposal: ExtractionProposal, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const undoRef = auditRef.collection('events').doc('undo')
          const [boqSnap, runSnap, auditSnap, undoSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(auditRef), transaction.get(undoRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          if (auditSnap.exists && !isAudit(auditSnap.data())) return { status: 409, body: { error: 'Proposal audit record is invalid' } }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          const existingAudit = auditSnap.exists && isAudit(auditSnap.data()) ? auditSnap.data() as ExtractionProposalAudit : null
          if (undoSnap.exists && isUndoEvent(undoSnap.data())) return { status: 409, body: { error: 'Proposal was already undone' } }
          if (existingAudit && !auditIdentityValid(proposal, existingAudit)) return invalidResponse('run_identity_mismatch')
          const actionTimestamp = now().toISOString()
          const result = acceptExtractionProposal({ boq, run: immutable.run, sourceRows: immutable.sourceRows, proposal, actorId, now: actionTimestamp, existingAudit })
          if (result.kind === 'invalid') return invalidResponse(result.code)
          if (result.kind === 'rejected') return { status: 409, body: { error: 'proposal_rejected', audit: result.audit } }
          if (result.kind === 'already_accepted') return { status: 200, body: { status: 'accepted', boq: result.boq, audit: result.audit, idempotent: true } }
          const acceptedBoq = { ...result.boq, updatedAt: actionTimestamp }
          const acceptedAudit = { ...result.audit, resultBoq: structuredClone(acceptedBoq) }
          transaction.update(boqRef, {
            sections: acceptedBoq.sections,
            totalItems: acceptedBoq.totalItems,
            grandTotal: acceptedBoq.grandTotal,
            updatedAt: actionTimestamp,
          })
          transaction.create(auditRef, acceptedAudit)
          return { status: 200, body: { status: 'accepted', boq: acceptedBoq, audit: acceptedAudit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal acceptance could not be saved' } }
      }
    },

    async reject(boqId: string, runId: string, proposalId: string, proposal: ExtractionProposal, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, auditSnap] = await Promise.all([transaction.get(boqRef), transaction.get(runRef), transaction.get(auditRef)])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          if (auditSnap.exists && !isAudit(auditSnap.data())) return { status: 409, body: { error: 'Proposal audit record is invalid' } }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          const existingAudit = auditSnap.exists && isAudit(auditSnap.data()) ? auditSnap.data() as ExtractionProposalAudit : null
          if (existingAudit && !auditIdentityValid(proposal, existingAudit)) return invalidResponse('run_identity_mismatch')
          let validatedProposal = proposal
          if (!existingAudit) {
            const validation = validateExtractionProposal(boq, immutable.run, immutable.sourceRows, proposal)
            if (!validation.valid) return invalidResponse(validation.code)
            validatedProposal = validation.proposal
          }
          const result = rejectExtractionProposal({ boq, proposal: validatedProposal, actorId, now: now().toISOString(), existingAudit, sourceRows: immutable.sourceRows })
          if (result.kind === 'invalid') return invalidResponse(result.code)
          if (result.kind === 'already_recorded') return { status: 200, body: { status: result.audit.status, audit: result.audit, idempotent: true } }
          transaction.create(auditRef, result.audit)
          return { status: 200, body: { status: 'rejected', audit: result.audit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal rejection could not be saved' } }
      }
    },

    async undo(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const undoRef = auditRef.collection('events').doc('undo')
          const [boqSnap, runSnap, auditSnap, undoSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(auditRef), transaction.get(undoRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready' || !auditSnap.exists || !isAudit(auditSnap.data())) {
            return { status: 404, body: { error: 'Accepted proposal not found' } }
          }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (undoSnap.exists && !isUndoEvent(undoSnap.data())) {
            return { status: 409, body: { error: 'Proposal undo record is invalid' } }
          }
          if (undoSnap.exists) {
            const event = undoSnap.data() as ExtractionProposalUndoEvent
            return {
              status: 200,
              body: { status: 'undone', boq: structuredClone(event.resultBoq), audit: event, idempotent: true },
            }
          }
          const acceptedAudit = auditSnap.data() as ExtractionProposalAudit
          const actionTimestamp = now().toISOString()
          const result = undoExtractionProposal({
            boq,
            audit: acceptedAudit,
            actorId,
            now: actionTimestamp,
            sourceRefs: acceptedAudit.sourceRefs,
          })
          if (result.kind === 'conflict') return { status: 409, body: { error: 'BOQ changed after proposal acceptance' } }
          if (result.kind === 'not_accepted') return { status: 409, body: { error: 'Proposal cannot be undone' } }
          const undoneBoq = { ...result.boq, updatedAt: actionTimestamp }
          const undoneAudit = { ...result.audit, resultBoq: structuredClone(undoneBoq) }
          transaction.update(boqRef, {
            sections: undoneBoq.sections,
            totalItems: undoneBoq.totalItems,
            grandTotal: undoneBoq.grandTotal,
            updatedAt: actionTimestamp,
          })
          transaction.create(undoRef, undoneAudit)
          return { status: 200, body: { status: 'undone', boq: undoneBoq, audit: undoneAudit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal undo could not be saved' } }
      }
    },
  }
}
