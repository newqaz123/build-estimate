import { auth } from '@/lib/auth'
import { createFirestoreExtractionStore } from '@/lib/boq-extraction-storage'
import { getDb, getDocument } from '@/lib/db'
import { callLLM } from '@/lib/llm'
import { createFirestoreExtractionProposalStore } from '@/lib/boq-extraction-proposal-store'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { automaticReviewCandidateRowIds, extractionReviewSourceRefs, extractionReviewSourceRowDisplays } from '@/lib/boq-extraction-ai-review'
import { createExtractionReviewHandler, type ExtractionReviewRouteContext } from './review-api'

const REVIEW_TIMEOUT_MS = 20_000

const handler = createExtractionReviewHandler({
  authenticate: auth,
  getReadyImport: (boqId, runId) => createFirestoreExtractionStore(getDb()).getReadyImport(boqId, runId),
  getSourceRows: (boqId, runId) => createFirestoreExtractionStore(getDb()).getSourceRows(boqId, runId),
  saveValidatedProposals: (boqId, runId, proposals) => createFirestoreExtractionProposalStore(getDb()).saveValidatedProposals(boqId, runId, proposals),
  getReviewState: (boqId, runId) => createFirestoreExtractionProposalStore(getDb()).getReviewState(boqId, runId),
  getSettings: () => getDocument<WorkspaceSettings>('settings', 'workspace'),
  callProvider: callLLM,
  env: process.env,
  timeoutMs: REVIEW_TIMEOUT_MS,
  // Only safe categorical failure reasons are logged; no BOQ source data or provider payloads.
  logCategory: (category) => console.warn('BOQ extraction AI review fallback', { category }),
})

/** Canonical structured review endpoint; run evidence is immutable under extraction-runs. */
export async function POST(request: Request, context: ExtractionReviewRouteContext) {
  return handler(request, context)
}

/** Reloads durable proposals and their audit-derived lifecycle without invoking the provider. */
export async function GET(_request: Request, context: ExtractionReviewRouteContext) {
  const session = await auth()
  if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { id, runId } = await context.params
  const extractionStore = createFirestoreExtractionStore(getDb())
  const proposalStore = createFirestoreExtractionProposalStore(getDb())
  try {
    const [imported, sourceRows, stored] = await Promise.all([
      extractionStore.getReadyImport(id, runId),
      extractionStore.getSourceRows(id, runId),
      proposalStore.getReviewState(id, runId),
    ])
    if (!imported || !stored) return Response.json({ error: 'Extraction run not found' }, { status: 404 })
    const proposalRowIds = new Set(stored.proposals.flatMap((proposal) => proposal.sourceRowIds))
    const candidateIds = automaticReviewCandidateRowIds(imported.run)
    const visibleIds = proposalRowIds.size > 0 ? proposalRowIds : new Set(candidateIds)
    const visibleRows = sourceRows.filter((row) => visibleIds.has(row.id))
    return Response.json({
      mode: stored.proposals.length > 0 ? 'ai' : 'not_required',
      aiStatus: stored.proposals.length > 0 ? 'completed' : 'not_required',
      message: stored.proposals.length > 0 ? 'Saved extraction suggestions loaded for review.' : 'No saved extraction suggestions are available.',
      sourceRowIds: visibleRows.map((row) => row.id),
      remainingCandidateRowIds: candidateIds.filter((rowId) => !proposalRowIds.has(rowId)),
      sourceRefs: extractionReviewSourceRefs(visibleRows),
      sourceRows: extractionReviewSourceRowDisplays(visibleRows),
      rejectedProposals: [],
      ...stored,
    })
  } catch {
    return Response.json({ error: 'Extraction review could not be loaded' }, { status: 500 })
  }
}
