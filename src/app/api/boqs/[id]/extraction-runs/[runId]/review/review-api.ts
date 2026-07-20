import type { Boq } from '@/lib/boq-schema'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import {
  automaticReviewCandidateRowIds,
  executeExtractionReview,
  extractionReviewSourceRefs,
  extractionReviewSourceRowDisplays,
  parseExtractionReviewRequest,
  type ExtractionReviewDependencies,
  type ExtractionReviewRejectedProposal,
} from '@/lib/boq-extraction-ai-review'
import type { ExtractionProposalReviewState, ExtractionReviewRunSummary } from '@/lib/boq-extraction-proposal-store'
import type { ValidatedProposal } from '@/lib/boq-extraction-proposals'
import { stableCanonicalJson } from '@/lib/boq-extraction-run'

export type ExtractionReviewRouteContext = { params: Promise<{ id: string; runId: string }> }

export interface ExtractionReviewHandlerDependencies extends Omit<ExtractionReviewDependencies, 'getContext'> {
  authenticate(): Promise<{ user?: unknown } | null>
  getReadyImport(boqId: string, runId: string): Promise<{ boq: Boq; run: BoqExtractionRun } | null>
  getSourceRows(boqId: string, runId: string): Promise<BoqSourceRowV3[]>
  saveValidatedProposals(boqId: string, runId: string, proposals: readonly ValidatedProposal[], refreshedSourceRowIds: readonly string[]): Promise<void>
  getReviewState(boqId: string, runId: string): Promise<ExtractionProposalReviewState | null>
  acquireReviewLease(boqId: string, runId: string, requestKey: string, leaseId: string, leaseTtlMs: number, force: boolean): Promise<{ kind: 'acquired' | 'busy' | 'complete' | 'failed'; reviewRun: ExtractionReviewRunSummary }>
  completeReviewLease(boqId: string, runId: string, leaseId: string, status: 'completed' | 'partial', proposals: readonly ValidatedProposal[]): Promise<ExtractionReviewRunSummary>
  failReviewLease(boqId: string, runId: string, leaseId: string, failureCode: string, retryDelayMs: number): Promise<ExtractionReviewRunSummary>
  createLeaseId(): string
}

const REVIEW_LEASE_MS = 30_000
const REVIEW_FAILURE_BACKOFF_MS = 30_000

export function buildDurableExtractionReviewResponse(input: {
  imported: { boq: Boq; run: BoqExtractionRun }
  sourceRows: BoqSourceRowV3[]
  stored: ExtractionProposalReviewState
  reviewRun?: ExtractionReviewRunSummary
  rejectedProposals?: ExtractionReviewRejectedProposal[]
}) {
  const reviewRun = {
    ...(input.reviewRun ?? input.stored.reviewRun),
    reviewTargeting: {
      candidateRowIds: automaticReviewCandidateRowIds(input.imported.run),
      ambiguousRowIds: [...(input.imported.run.reviewTargeting.ambiguousRowIds ?? [])],
      unreconciledRowIds: [...(input.imported.run.reviewTargeting.unreconciledRowIds ?? [])],
      unreconciled: input.imported.run.reviewTargeting.unreconciled,
    },
  }
  const proposalRowIds = new Set(input.stored.proposals.flatMap((proposal) => proposal.sourceRowIds))
  const visibleIds = new Set([...reviewRun.reviewTargeting.candidateRowIds, ...proposalRowIds])
  const visibleRows = input.sourceRows.filter((row) => visibleIds.has(row.id))
  const failure = reviewRun.failureCode
  const knownFailure = ['provider_not_configured', 'unsupported_provider', 'unauthorized', 'rate_limited', 'timeout', 'malformed_response', 'provider_failure'].includes(failure ?? '')
    ? failure
    : 'provider_failure'
  return {
    snapshotMode: 'replace' as const,
    mode: input.stored.proposals.length > 0 ? 'ai' as const : reviewRun.status === 'failed' ? 'fallback' as const : 'not_required' as const,
    aiStatus: reviewRun.status === 'failed' ? knownFailure : reviewRun.status === 'completed' || reviewRun.status === 'partial' ? 'completed' : 'not_required',
    message: reviewRun.status === 'running'
      ? 'Extraction review is running.'
      : reviewRun.status === 'failed'
        ? 'AI review is temporarily unavailable. The deterministic extraction remains unchanged.'
        : input.stored.proposals.length > 0 ? 'Saved extraction suggestions loaded for review.' : 'No saved extraction suggestions are available.',
    sourceRowIds: visibleRows.map((row) => row.id),
    remainingCandidateRowIds: reviewRun.reviewTargeting.candidateRowIds.filter((rowId) => !proposalRowIds.has(rowId)),
    sourceRefs: extractionReviewSourceRefs(visibleRows),
    sourceRows: extractionReviewSourceRowDisplays(visibleRows),
    rejectedProposals: input.rejectedProposals ?? [],
    ...input.stored,
    reviewRun,
  }
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
    let parsedRequest
    try {
      parsedRequest = parseExtractionReviewRequest(body)
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Malformed extraction review request' }, { status: 400 })
    }
    const requestKey = stableCanonicalJson(parsedRequest)
    const leaseId = dependencies.createLeaseId()
    let lease
    try {
      lease = await dependencies.acquireReviewLease(id, runId, requestKey, leaseId, REVIEW_LEASE_MS, parsedRequest.manual)
    } catch {
      return Response.json({ error: 'Extraction run not found' }, { status: 404 })
    }
    const loadSnapshot = async (reviewRun?: ExtractionReviewRunSummary, rejectedProposals?: ExtractionReviewRejectedProposal[]) => {
      const [imported, sourceRows, stored] = await Promise.all([
        dependencies.getReadyImport(id, runId), dependencies.getSourceRows(id, runId), dependencies.getReviewState(id, runId),
      ])
      if (!imported || !stored) return null
      return buildDurableExtractionReviewResponse({ imported, sourceRows, stored, reviewRun, rejectedProposals })
    }
    if (lease.kind !== 'acquired') {
      try {
        const snapshot = await loadSnapshot(lease.reviewRun)
        if (!snapshot) return Response.json({ error: 'Extraction run not found' }, { status: 404 })
        return Response.json(snapshot, { status: lease.kind === 'busy' ? 202 : 200 })
      } catch {
        return Response.json({ error: 'Extraction review could not be loaded' }, { status: 500 })
      }
    }
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
    if (result.status !== 200) {
      await dependencies.failReviewLease(id, runId, leaseId, 'invalid_request', 0).catch(() => undefined)
      return Response.json(result.body, { status: result.status })
    }
    try {
      let finalRun: ExtractionReviewRunSummary
      if (result.body.mode === 'fallback') {
        finalRun = await dependencies.failReviewLease(id, runId, leaseId, result.body.aiStatus, REVIEW_FAILURE_BACKOFF_MS)
      } else {
        if (result.body.mode === 'ai') await dependencies.saveValidatedProposals(id, runId, result.body.proposals, result.body.sourceRowIds)
        const status = result.body.rejectedProposals.length > 0 ? 'partial' : 'completed'
        finalRun = await dependencies.completeReviewLease(id, runId, leaseId, status, result.body.proposals)
      }
      const snapshot = await loadSnapshot(finalRun, result.body.rejectedProposals)
      if (!snapshot) return Response.json({ error: 'Extraction run not found' }, { status: 404 })
      return Response.json(snapshot, { status: 200 })
    } catch {
      return Response.json({ error: 'Extraction review could not be saved' }, { status: 500 })
    }
  }
}
