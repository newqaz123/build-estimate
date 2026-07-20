import type { Firestore } from 'firebase-admin/firestore'
import type { Boq } from './boq-schema'
import { extractionRunPath, createFirestoreExtractionStore } from './boq-extraction-storage'
import type { ExtractionProposal } from './boq-extraction-proposals'
import {
  acceptExtractionProposal,
  rejectExtractionProposal,
  undoExtractionProposal,
  validateExtractionProposal,
  type ExtractionProposalAudit,
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
    && typeof (value as ExtractionProposalAudit).status === 'string'
}

function invalidResponse(code: string): ProposalStoreResponse {
  const status = code === 'stale_item' ? 409 : 400
  return { status, body: { error: code } }
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
          const [boqSnap, runSnap, auditSnap] = await Promise.all([transaction.get(boqRef), transaction.get(runRef), transaction.get(auditRef)])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          const existingAudit = auditSnap.exists && isAudit(auditSnap.data()) ? auditSnap.data() as ExtractionProposalAudit : null
          const result = acceptExtractionProposal({ boq, run: immutable.run, sourceRows: immutable.sourceRows, proposal, actorId, now: now().toISOString(), existingAudit })
          if (result.kind === 'invalid') return invalidResponse(result.code)
          if (result.kind === 'rejected') return { status: 409, body: { error: 'proposal_rejected', audit: result.audit } }
          if (result.kind === 'already_accepted') return { status: 200, body: { status: 'accepted', boq, audit: result.audit, idempotent: true } }
          transaction.update(boqRef, {
            sections: result.boq.sections,
            totalItems: result.boq.totalItems,
            grandTotal: result.boq.grandTotal,
            updatedAt: now().toISOString(),
          })
          transaction.create(auditRef, result.audit)
          return { status: 200, body: { status: 'accepted', boq: result.boq, audit: result.audit } }
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
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          const existingAudit = auditSnap.exists && isAudit(auditSnap.data()) ? auditSnap.data() as ExtractionProposalAudit : null
          if (!existingAudit) {
            const validation = validateExtractionProposal(boq, immutable.run, immutable.sourceRows, proposal)
            if (!validation.valid) return invalidResponse(validation.code)
          }
          const result = rejectExtractionProposal({ boq, proposal, actorId, now: now().toISOString(), existingAudit, sourceRows: immutable.sourceRows })
          if (result.kind === 'already_recorded') return { status: 200, body: { status: result.audit.status, audit: result.audit, idempotent: true } }
          transaction.create(auditRef, result.audit)
          return { status: 200, body: { status: 'rejected', audit: result.audit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal rejection could not be saved' } }
      }
    },

    async undo(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, auditSnap] = await Promise.all([transaction.get(boqRef), transaction.get(runRef), transaction.get(auditRef)])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready' || !auditSnap.exists || !isAudit(auditSnap.data())) {
            return { status: 404, body: { error: 'Accepted proposal not found' } }
          }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          const result = undoExtractionProposal({ boq, audit: auditSnap.data() as ExtractionProposalAudit, actorId, now: now().toISOString() })
          if (result.kind === 'conflict') return { status: 409, body: { error: 'BOQ changed after proposal acceptance' } }
          if (result.kind === 'not_accepted') return { status: 409, body: { error: 'Proposal cannot be undone' } }
          transaction.update(boqRef, {
            sections: result.boq.sections,
            totalItems: result.boq.totalItems,
            grandTotal: result.boq.grandTotal,
            updatedAt: now().toISOString(),
          })
          transaction.update(auditRef, { ...result.audit })
          return { status: 200, body: { status: 'undone', boq: result.boq, audit: result.audit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal undo could not be saved' } }
      }
    },
  }
}
