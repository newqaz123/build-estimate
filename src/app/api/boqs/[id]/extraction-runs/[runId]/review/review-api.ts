import type { Boq } from '@/lib/boq-schema'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import { executeExtractionReview, type ExtractionReviewDependencies } from '@/lib/boq-extraction-ai-review'

export type ExtractionReviewRouteContext = { params: Promise<{ id: string; runId: string }> }

export interface ExtractionReviewHandlerDependencies extends Omit<ExtractionReviewDependencies, 'getContext'> {
  authenticate(): Promise<{ user?: unknown } | null>
  getReadyImport(boqId: string, runId: string): Promise<{ boq: Boq; run: BoqExtractionRun } | null>
  getSourceRows(boqId: string, runId: string): Promise<BoqSourceRowV3[]>
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
    return Response.json(result.body, { status: result.status })
  }
}
