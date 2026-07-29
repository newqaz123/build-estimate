import { auth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { createFirestoreExtractionProposalStore } from '@/lib/boq-extraction-proposal-store'
import { createExtractionProposalActionHandlers, type ExtractionProposalActionContext } from '../../proposals-api'

const store = () => createFirestoreExtractionProposalStore(getDb())
const handlers = createExtractionProposalActionHandlers({
  authenticate: auth,
  accept: (boqId, runId, proposalId, actorId) => store().accept(boqId, runId, proposalId, actorId),
  acceptBatch: (boqId, runId, proposalIds, actorId) => store().acceptBatch(boqId, runId, proposalIds, actorId),
  reject: (boqId, runId, proposalId, actorId) => store().reject(boqId, runId, proposalId, actorId),
  skip: (boqId, runId, proposalId, actorId) => store().skip(boqId, runId, proposalId, actorId),
  addSourceItem: (boqId, runId, proposalId, request, actorId) => store().addSourceItem(boqId, runId, proposalId, request, actorId),
  reopen: (boqId, runId, proposalId, actorId) => store().reopen(boqId, runId, proposalId, actorId),
  undo: (boqId, runId, proposalId, actorId) => store().undo(boqId, runId, proposalId, actorId),
})

export async function POST(request: Request, context: ExtractionProposalActionContext) {
  return handlers.skip(request, context)
}
