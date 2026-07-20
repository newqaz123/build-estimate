import type { Firestore } from 'firebase-admin/firestore'
import type { Boq } from './boq-schema'
import { extractionRunPath, sourceRowPath, createFirestoreExtractionStore } from './boq-extraction-storage'
import { checksumSourceRows, extractionRunIdentityFingerprint, fingerprintParserConfig, stableCanonicalJson, type BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import type { ExtractionProposal, ValidatedProposal } from './boq-extraction-proposals'
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

export type ExtractionProposalStatus = 'pending' | 'accepted' | 'rejected' | 'undone'
export interface ExtractionProposalStatusSummary {
  status: ExtractionProposalStatus
  canUndo: boolean
}
export interface ExtractionProposalReviewState {
  proposals: ValidatedProposal[]
  proposalStatuses: Record<string, ExtractionProposalStatusSummary>
  auditEvents: Array<ExtractionProposalAudit | ExtractionProposalUndoEvent>
}

function auditPath(boqId: string, runId: string, proposalId: string): string {
  return `${extractionRunPath(boqId, runId)}/proposalAudits/${proposalId}`
}

function proposalPath(boqId: string, runId: string, proposalId: string): string {
  return `${extractionRunPath(boqId, runId)}/proposals/${proposalId}`
}

function storedProposal(value: unknown, expectedId?: string): ValidatedProposal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proposal = (value as { proposal?: unknown }).proposal
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return null
  const candidate = proposal as ValidatedProposal
  if (typeof candidate.id !== 'string' || (expectedId !== undefined && candidate.id !== expectedId)
    || candidate.evidenceValid !== true || candidate.reconciled !== true || candidate.stale !== false) return null
  return structuredClone(candidate)
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
    async saveValidatedProposals(boqId: string, runId: string, proposals: readonly ValidatedProposal[]): Promise<void> {
      const immutable = await loadImmutable(boqId, runId)
      if (!immutable) throw new Error('Extraction run not found')
      await db.runTransaction(async (transaction) => {
        const boqRef = db.collection('boqs').doc(boqId)
        const runRef = db.doc(extractionRunPath(boqId, runId))
        const proposalRefs = proposals.map((proposal) => db.doc(proposalPath(boqId, runId, proposal.id)))
        const [boqSnap, runSnap, ...proposalSnaps] = await Promise.all([
          transaction.get(boqRef), transaction.get(runRef), ...proposalRefs.map((ref) => transaction.get(ref)),
        ])
        if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready'
          || !await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
          throw new Error('Extraction run not found')
        }
        const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
        const timestamp = now().toISOString()
        proposals.forEach((proposal, index) => {
          const validation = validateExtractionProposal(boq, immutable.run, immutable.sourceRows, proposal)
          if (!validation.valid) throw new Error(`Invalid proposal: ${validation.code}`)
          const existing = proposalSnaps[index]
          if (existing.exists) {
            const current = storedProposal(existing.data(), proposal.id)
            if (!current || stableCanonicalJson(current) !== stableCanonicalJson(validation.proposal)) {
              throw new Error('Stored proposal identity conflict')
            }
            return
          }
          transaction.create(proposalRefs[index], { proposal: structuredClone(validation.proposal), createdAt: timestamp })
        })
      })
    },

    async getReviewState(boqId: string, runId: string): Promise<ExtractionProposalReviewState | null> {
      const immutable = await loadImmutable(boqId, runId)
      if (!immutable) return null
      const runRef = db.doc(extractionRunPath(boqId, runId))
      const [proposalPage, auditPage] = await Promise.all([
        runRef.collection('proposals').orderBy('createdAt').get(),
        runRef.collection('proposalAudits').orderBy('timestamp').get(),
      ])
      const proposals = proposalPage.docs.map((snapshot) => storedProposal(snapshot.data(), snapshot.id))
      if (proposals.some((proposal) => !proposal)) throw new Error('Stored proposal record is invalid')
      const audits = auditPage.docs.map((snapshot) => isAudit(snapshot.data()) ? snapshot.data() as ExtractionProposalAudit : null)
      if (audits.some((audit) => !audit)) throw new Error('Proposal audit record is invalid')
      const undoSnaps = await Promise.all(proposals.map((proposal) => db.doc(auditPath(boqId, runId, proposal!.id)).collection('events').doc('undo').get()))
      const proposalStatuses: Record<string, ExtractionProposalStatusSummary> = {}
      const auditByProposal = new Map(audits.map((audit) => [audit!.proposalId, audit!]))
      const auditEvents: Array<ExtractionProposalAudit | ExtractionProposalUndoEvent> = audits as ExtractionProposalAudit[]
      proposals.forEach((proposal, index) => {
        const undo = undoSnaps[index].exists ? undoSnaps[index].data() : null
        if (undo && !isUndoEvent(undo)) throw new Error('Proposal undo record is invalid')
        if (undo) {
          proposalStatuses[proposal!.id] = { status: 'undone', canUndo: false }
          auditEvents.push(undo as ExtractionProposalUndoEvent)
          return
        }
        const audit = auditByProposal.get(proposal!.id)
        proposalStatuses[proposal!.id] = audit
          ? { status: audit.status, canUndo: audit.status === 'accepted' }
          : { status: 'pending', canUndo: false }
      })
      return { proposals: proposals as ValidatedProposal[], proposalStatuses, auditEvents }
    },

    async accept(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const undoRef = auditRef.collection('events').doc('undo')
          const [boqSnap, runSnap, proposalSnap, auditSnap, undoSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef), transaction.get(auditRef), transaction.get(undoRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          const proposal = proposalSnap.exists ? storedProposal(proposalSnap.data(), proposalId) : null
          if (!proposal) return { status: 404, body: { error: 'Stored proposal not found' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          if (auditSnap.exists && !isAudit(auditSnap.data())) return { status: 409, body: { error: 'Proposal audit record is invalid' } }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot be changed by extraction proposals' } }
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

    async reject(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, proposalSnap, auditSnap] = await Promise.all([transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef), transaction.get(auditRef)])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          const proposal = proposalSnap.exists ? storedProposal(proposalSnap.data(), proposalId) : null
          if (!proposal) return { status: 404, body: { error: 'Stored proposal not found' } }
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
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot be changed by extraction proposals' } }
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

    async acceptBatch(boqId: string, runId: string, proposalIds: readonly string[], actorId: string): Promise<ProposalStoreResponse> {
      if (proposalIds.length === 0 || proposalIds.length > 100 || new Set(proposalIds).size !== proposalIds.length) {
        return { status: 400, body: { error: 'Invalid proposal batch' } }
      }
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const proposalRefs = proposalIds.map((id) => db.doc(proposalPath(boqId, runId, id)))
          const auditRefs = proposalIds.map((id) => db.doc(auditPath(boqId, runId, id)))
          const undoRefs = auditRefs.map((ref) => ref.collection('events').doc('undo'))
          const [boqSnap, runSnap, proposalSnaps, auditSnaps, undoSnaps] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.getAll(...proposalRefs),
            transaction.getAll(...auditRefs), transaction.getAll(...undoRefs),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposals' } }
          }
          const proposals = proposalSnaps.map((snapshot, index) => snapshot.exists ? storedProposal(snapshot.data(), proposalIds[index]) : null)
          if (proposals.some((proposal) => !proposal)) return { status: 404, body: { error: 'Stored proposal not found' } }
          if (auditSnaps.some((snapshot) => snapshot.exists && !isAudit(snapshot.data()))
            || undoSnaps.some((snapshot) => snapshot.exists && !isUndoEvent(snapshot.data()))) {
            return { status: 409, body: { error: 'Proposal audit record is invalid' } }
          }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot be changed by extraction proposals' } }
          const existingAudits = auditSnaps.map((snapshot) => snapshot.exists ? snapshot.data() as ExtractionProposalAudit : null)
          if (existingAudits.some(Boolean) || undoSnaps.some((snapshot) => snapshot.exists)) {
            const replayable = existingAudits.every((audit, index) => audit?.status === 'accepted'
              && auditIdentityValid(proposals[index]!, audit) && !undoSnaps[index].exists && isBoqSnapshot(audit.resultBoq))
            if (!replayable) return { status: 409, body: { error: 'Proposal batch is no longer pending' } }
            return {
              status: 200,
              body: { status: 'accepted', acceptedProposalIds: [...proposalIds], boq: structuredClone(existingAudits.at(-1)!.resultBoq), idempotent: true },
            }
          }
          const seenTargets = new Set<string>()
          const seenRows = new Set<string>()
          for (const proposal of proposals as ValidatedProposal[]) {
            if (proposal.targetItemIds.some((id) => seenTargets.has(id)) || proposal.sourceRowIds.some((id) => seenRows.has(id))) {
              return { status: 409, body: { error: 'Proposal batch contains overlapping changes' } }
            }
            proposal.targetItemIds.forEach((id) => seenTargets.add(id))
            proposal.sourceRowIds.forEach((id) => seenRows.add(id))
          }
          const actionTimestamp = now().toISOString()
          let currentBoq = boq
          const audits: ExtractionProposalAudit[] = []
          for (const proposal of proposals as ValidatedProposal[]) {
            const result = acceptExtractionProposal({
              boq: currentBoq, run: immutable.run, sourceRows: immutable.sourceRows,
              proposal, actorId, now: actionTimestamp, existingAudit: null,
            })
            if (result.kind !== 'accepted') {
              const error = result.kind === 'invalid' ? result.code : 'Proposal batch is no longer pending'
              return result.kind === 'invalid' ? invalidResponse(error) : { status: 409, body: { error } }
            }
            currentBoq = result.boq
            audits.push(result.audit)
          }
          const acceptedBoq = { ...currentBoq, updatedAt: actionTimestamp }
          transaction.update(boqRef, {
            sections: acceptedBoq.sections, totalItems: acceptedBoq.totalItems,
            grandTotal: acceptedBoq.grandTotal, updatedAt: actionTimestamp,
          })
          audits.forEach((audit, index) => transaction.create(auditRefs[index], {
            ...audit, resultBoq: structuredClone(acceptedBoq), batchProposalIds: [...proposalIds],
          }))
          return { status: 200, body: { status: 'accepted', acceptedProposalIds: [...proposalIds], boq: acceptedBoq, audits } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal batch acceptance could not be saved' } }
      }
    },
  }
}
