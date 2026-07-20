import type { ExtractionProposal } from '@/lib/boq-extraction-proposals'
import type { ExtractionProposalAudit } from '@/lib/boq-extraction-acceptance'

export type ExtractionProposalActionContext = { params: Promise<{ id: string; runId: string; proposalId: string }> }

export type ProposalActionResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409 | 500; body: { error: string } }

export interface ExtractionProposalActionDependencies {
  authenticate(): Promise<{ user?: { id?: string } } | null>
  accept(boqId: string, runId: string, proposalId: string, proposal: ExtractionProposal, actorId: string): Promise<ProposalActionResult>
  reject(boqId: string, runId: string, proposalId: string, proposal: ExtractionProposal, actorId: string): Promise<ProposalActionResult>
  undo(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalActionResult>
}

function validPathId(value: string): boolean {
  return value.trim() !== '' && !value.includes('/') && value.length <= 240
}

async function parseProposal(request: Request, expectedProposalId: string): Promise<ExtractionProposal | null> {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body as Record<string, unknown>).length !== 1
      || !('proposal' in (body as Record<string, unknown>))) return null
    const proposal = (body as { proposal: unknown }).proposal
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
      || (proposal as { id?: unknown }).id !== expectedProposalId) return null
    return proposal as ExtractionProposal
  } catch {
    return null
  }
}

function actorId(session: { user?: { id?: string } } | null): string | null {
  const id = session?.user?.id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

export function createExtractionProposalActionHandlers(dependencies: ExtractionProposalActionDependencies) {
  async function accept(request: Request, context: ExtractionProposalActionContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId, proposalId } = await context.params
    if (![id, runId, proposalId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    const proposal = await parseProposal(request, proposalId)
    if (!proposal) return Response.json({ error: 'Malformed proposal request' }, { status: 400 })
    const result = await dependencies.accept(id, runId, proposalId, proposal, user)
    return Response.json(result.body, { status: result.status })
  }

  async function reject(request: Request, context: ExtractionProposalActionContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId, proposalId } = await context.params
    if (![id, runId, proposalId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    const proposal = await parseProposal(request, proposalId)
    if (!proposal) return Response.json({ error: 'Malformed proposal request' }, { status: 400 })
    const result = await dependencies.reject(id, runId, proposalId, proposal, user)
    return Response.json(result.body, { status: result.status })
  }

  async function undo(_request: Request, context: ExtractionProposalActionContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId, proposalId } = await context.params
    if (![id, runId, proposalId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    const result = await dependencies.undo(id, runId, proposalId, user)
    return Response.json(result.body, { status: result.status })
  }

  return { accept, reject, undo }
}

export type { ExtractionProposalAudit }
