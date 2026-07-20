import type { Boq } from '@/lib/boq-schema'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import { executeExtractionReview, type ExtractionReviewDependencies } from '@/lib/boq-extraction-ai-review'
import type { ExtractionProposalReviewState } from '@/lib/boq-extraction-proposal-store'
import type { ValidatedProposal } from '@/lib/boq-extraction-proposals'

export type ExtractionReviewRouteContext = { params: Promise<{ id: string; runId: string }> }

export interface ExtractionReviewHandlerDependencies extends Omit<ExtractionReviewDependencies, 'getContext'> {
  authenticate(): Promise<{ user?: unknown } | null>
  getReadyImport(boqId: string, runId: string): Promise<{ boq: Boq; run: BoqExtractionRun } | null>
  getSourceRows(boqId: string, runId: string): Promise<BoqSourceRowV3[]>
  saveValidatedProposals(boqId: string, runId: string, proposals: readonly ValidatedProposal[]): Promise<void>
  getReviewState(boqId: string, runId: string): Promise<ExtractionProposalReviewState | null>
}

export function createExtractionReviewHandler(dependencies: ExtractionReviewHandlerDependencies) {
  return async function POST(request: Request, { params }: ExtractionReviewRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'Malformed JSON request' }, { status: 400 })
    }
    const { id, runId } = await params
    const result = await executeExtractionReview(body, id, runId, {
      getContext: async (boqId, extractionRunId) => {
        const imported = await dependencies.getReadyImport(boqId, extractionRunId)
        if (!imported) return null
        const sourceRows = await dependencies.getSourceRows(boqId, extractionRunId)
        return { ...imported, sourceRows }
      },
      getSettings: dependencies.getSettings,
      callProvider: dependencies.callProvider,
      env: dependencies.env,
      timeoutMs: dependencies.timeoutMs,
      logCategory: dependencies.logCategory,
    })
    if (result.status !== 200) return Response.json(result.body, { status: result.status })
    try {
      if (result.body.mode === 'ai') await dependencies.saveValidatedProposals(id, runId, result.body.proposals)
      const stored = await dependencies.getReviewState(id, runId)
      if (!stored) return Response.json({ error: 'Extraction run not found' }, { status: 404 })
      return Response.json({ ...result.body, ...stored }, { status: 200 })
    } catch {
      return Response.json({ error: 'Extraction review could not be saved' }, { status: 500 })
    }
  }
}
