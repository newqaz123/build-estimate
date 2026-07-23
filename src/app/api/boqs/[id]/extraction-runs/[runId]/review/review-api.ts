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
import type { ProposalValidationFailureCode, ProposalValidationSummary, ValidatedProposal } from '@/lib/boq-extraction-proposals'
import { stableCanonicalJson } from '@/lib/boq-extraction-run'

export type ExtractionReviewRouteContext = { params: Promise<{ id: string; runId: string }> }

export interface ExtractionReviewHandlerDependencies extends Omit<ExtractionReviewDependencies, 'getContext'> {
  authenticate(): Promise<{ user?: unknown } | null>
  getReadyImport(boqId: string, runId: string): Promise<{ boq: Boq; run: BoqExtractionRun } | null>
  getSourceRows(boqId: string, runId: string): Promise<BoqSourceRowV3[]>
  getReviewState(boqId: string, runId: string): Promise<ExtractionProposalReviewState | null>
  acquireReviewLease(boqId: string, runId: string, requestKey: string, leaseId: string, leaseTtlMs: number, force: boolean): Promise<{ kind: 'acquired' | 'busy' | 'complete' | 'failed'; reviewRun: ExtractionReviewRunSummary }>
  completeReviewLease(boqId: string, runId: string, leaseId: string, status: 'completed' | 'partial', proposals: readonly ValidatedProposal[], refreshedSourceRowIds: readonly string[], validationSummary: ProposalValidationSummary | null): Promise<ExtractionReviewRunSummary>
  failReviewLease(boqId: string, runId: string, leaseId: string, failureCode: string, retryDelayMs: number): Promise<ExtractionReviewRunSummary>
  createLeaseId(): string
}

const REVIEW_LEASE_MS = 30_000
const REVIEW_FAILURE_BACKOFF_MS = 30_000

function buildValidationSummary(validatedCount: number, rejected: readonly ExtractionReviewRejectedProposal[]): ProposalValidationSummary {
  const rejectionCounts: Partial<Record<ProposalValidationFailureCode, number>> = {}
  for (const entry of rejected) {
    if (!entry.code) continue
    rejectionCounts[entry.code] = (rejectionCounts[entry.code] ?? 0) + 1
  }
  return {
    validatedProposalCount: validatedCount,
    rejectedProposalCount: rejected.length,
    ...(Object.keys(rejectionCounts).length > 0 ? { rejectionCounts } : {}),
  }
}

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
  const reviewedSourceRowIds = new Set(input.stored.reviewRun.reviewedSourceRowIds ?? proposalRowIds)
  const visibleIds = new Set([...reviewRun.reviewTargeting.candidateRowIds, ...proposalRowIds])
  const visibleRows = input.sourceRows.filter((row) => visibleIds.has(row.id))
  const candidateCount = reviewRun.reviewTargeting.candidateRowIds.length
  const reviewedCount = reviewRun.reviewTargeting.candidateRowIds.filter((rowId) => reviewedSourceRowIds.has(rowId)).length
  const remainingCount = reviewRun.reviewTargeting.candidateRowIds.filter((rowId) => !reviewedSourceRowIds.has(rowId)).length
  const proposalCount = input.stored.proposals.length
  const validationSummary = reviewRun.validationSummary ?? null
  const failure = reviewRun.failureCode
  const knownFailure = ['provider_not_configured', 'unsupported_provider', 'unauthorized', 'rate_limited', 'timeout', 'malformed_response', 'provider_failure'].includes(failure ?? '')
    ? failure
    : 'provider_failure'
  const hasCandidates = candidateCount > 0
  const mode: 'ai' | 'fallback' | 'not_required' = reviewRun.status === 'failed'
    ? 'fallback'
    : !hasCandidates
      ? 'not_required'
      : 'ai'
  const aiStatus = reviewRun.status === 'failed'
    ? knownFailure
    : reviewRun.status === 'completed' || reviewRun.status === 'partial'
      ? 'completed'
      : hasCandidates
        ? 'not_required'
        : 'not_required'
  const progress = candidateCount > 0
    ? `${reviewedCount} of ${candidateCount} candidate row${candidateCount === 1 ? '' : 's'} reviewed · ${remainingCount} pending.`
    : ''
  const message = reviewRun.status === 'running'
    ? 'Extraction review is running.'
    : reviewRun.status === 'queued'
      ? 'Extraction review is queued.'
      : reviewRun.status === 'failed'
        ? 'AI review is temporarily unavailable. The deterministic extraction remains unchanged.'
        : !hasCandidates
          ? 'No ambiguous, unreconciled, or compound rows require review.'
          : proposalCount > 0 && validationSummary && validationSummary.rejectedProposalCount > 0
            ? `${proposalCount} suggestion${proposalCount === 1 ? '' : 's'} ready; ${validationSummary.rejectedProposalCount} blocked by validation. ${progress}`
            : proposalCount > 0
              ? `Saved extraction suggestions loaded for review. ${progress}`
              : validationSummary && validationSummary.rejectedProposalCount > 0
                ? `AI returned ${validationSummary.rejectedProposalCount} suggestion${validationSummary.rejectedProposalCount === 1 ? '' : 's'}, but none passed evidence and reconciliation checks. The BOQ remains unchanged. ${progress}`
                : reviewRun.status === 'partial'
                  ? `Review partially completed. Recheck with AI to restore validation details. ${progress}`
                  : `No correction recommended for the reviewed rows. ${progress}`
  return {
    snapshotMode: 'replace' as const,
    mode,
    aiStatus,
    message,
    sourceRowIds: visibleRows.map((row) => row.id),
    remainingCandidateRowIds: reviewRun.reviewTargeting.candidateRowIds.filter((rowId) => !reviewedSourceRowIds.has(rowId)),
    sourceRefs: extractionReviewSourceRefs(visibleRows),
    sourceRows: extractionReviewSourceRowDisplays(visibleRows),
    rejectedProposals: input.rejectedProposals ?? [],
    ...input.stored,
    reviewRun: { ...reviewRun, ...(validationSummary ? { validationSummary } : {}) },
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
      lease = await dependencies.acquireReviewLease(id, runId, requestKey, leaseId, REVIEW_LEASE_MS, parsedRequest.manual || parsedRequest.force === true)
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
        const status = result.body.rejectedProposals.length > 0 ? 'partial' : 'completed'
        const summary = buildValidationSummary(result.body.proposals.length, result.body.rejectedProposals)
        finalRun = await dependencies.completeReviewLease(id, runId, leaseId, status, result.body.proposals, result.body.sourceRowIds, summary)
      }
      const snapshot = await loadSnapshot(finalRun, result.body.rejectedProposals)
      if (!snapshot) return Response.json({ error: 'Extraction run not found' }, { status: 404 })
      return Response.json(snapshot, { status: 200 })
    } catch {
      return Response.json({ error: 'Extraction review could not be saved' }, { status: 500 })
    }
  }
}
