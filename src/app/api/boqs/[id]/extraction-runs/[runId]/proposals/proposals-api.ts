import type { ExtractionProposalAudit } from '@/lib/boq-extraction-acceptance'
import { MissingBoqItemError, parseSourceBackedManualAddRequest, type SourceBackedManualAddRequest } from '@/lib/boq-user-entry'

export type ExtractionProposalActionContext = { params: Promise<{ id: string; runId: string; proposalId: string }> }
export type ExtractionProposalBatchContext = { params: Promise<{ id: string; runId: string }> }

export type ProposalActionResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409 | 500; body: { error: string } }

export interface ExtractionProposalActionDependencies {
  authenticate(): Promise<{ user?: { id?: string } } | null>
  accept(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalActionResult>
  acceptBatch(boqId: string, runId: string, proposalIds: string[], actorId: string): Promise<ProposalActionResult>
  reject(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalActionResult>
  skip(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalActionResult>
  reopen(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalActionResult>
  undo(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalActionResult>
  addSourceItem(boqId: string, runId: string, proposalId: string, request: SourceBackedManualAddRequest, actorId: string): Promise<ProposalActionResult>
}

function validPathId(value: string): boolean {
  return value.trim() !== '' && !value.includes('/') && value.length <= 240
}

async function parseProposalIds(request: Request): Promise<string[] | null> {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body as Record<string, unknown>).length !== 1
      || !Array.isArray((body as { proposalIds?: unknown }).proposalIds)) return null
    const ids = (body as { proposalIds: unknown[] }).proposalIds
    if (ids.length === 0 || ids.length > 100 || !ids.every((id) => typeof id === 'string' && validPathId(id))
      || new Set(ids).size !== ids.length) return null
    return ids as string[]
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
    // Legacy clients may still echo a proposal body. It is deliberately ignored:
    // the server reloads the validated proposal by opaque path id.
    void request
    const result = await dependencies.accept(id, runId, proposalId, user)
    return Response.json(result.body, { status: result.status })
  }

  async function reject(request: Request, context: ExtractionProposalActionContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId, proposalId } = await context.params
    if (![id, runId, proposalId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    void request
    const result = await dependencies.reject(id, runId, proposalId, user)
    return Response.json(result.body, { status: result.status })
  }

  async function skip(_request: Request, context: ExtractionProposalActionContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId, proposalId } = await context.params
    if (![id, runId, proposalId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    const result = await dependencies.skip(id, runId, proposalId, user)
    return Response.json(result.body, { status: result.status })
  }

  async function reopen(_request: Request, context: ExtractionProposalActionContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId, proposalId } = await context.params
    if (![id, runId, proposalId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    const result = await dependencies.reopen(id, runId, proposalId, user)
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

  async function acceptBatch(request: Request, context: ExtractionProposalBatchContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId } = await context.params
    if (![id, runId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    const proposalIds = await parseProposalIds(request)
    if (!proposalIds) return Response.json({ error: 'Malformed proposal batch request' }, { status: 400 })
    const result = await dependencies.acceptBatch(id, runId, proposalIds, user)
    return Response.json(result.body, { status: result.status })
  }

  async function addSourceItem(request: Request, context: ExtractionProposalActionContext): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id, runId, proposalId } = await context.params
    if (![id, runId, proposalId].every(validPathId)) return Response.json({ error: 'Invalid extraction proposal path' }, { status: 400 })
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
    }
    let parsed: SourceBackedManualAddRequest
    try {
      parsed = parseSourceBackedManualAddRequest(body)
    } catch (error) {
      if (error instanceof MissingBoqItemError) return Response.json({ error: error.message }, { status: 400 })
      throw error
    }
    const result = await dependencies.addSourceItem(id, runId, proposalId, parsed, user)
    return Response.json(result.body, { status: result.status })
  }

  return { accept, acceptBatch, reject, skip, reopen, undo, addSourceItem }
}

export type { ExtractionProposalAudit }
