import { auth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { createFirestoreExtractionProposalStore } from '@/lib/boq-extraction-proposal-store'
import { createExtractionProposalActionHandlers, type ExtractionProposalActionContext } from '../../proposals-api'

const store = () => createFirestoreExtractionProposalStore(getDb())
const handlers = createExtractionProposalActionHandlers({
  authenticate: auth,
  accept: (boqId, runId, proposalId, proposal, actorId) => store().accept(boqId, runId, proposalId, proposal, actorId),
  reject: (boqId, runId, proposalId, proposal, actorId) => store().reject(boqId, runId, proposalId, proposal, actorId),
  undo: (boqId, runId, proposalId, actorId) => store().undo(boqId, runId, proposalId, actorId),
})

export async function POST(request: Request, context: ExtractionProposalActionContext) {
  return handlers.reject(request, context)
}
