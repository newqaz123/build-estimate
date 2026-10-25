import { auth } from '@/lib/auth'
import { createFirestoreExtractionStore } from '@/lib/boq-extraction-storage'
import { getDb, getDocument } from '@/lib/db'
import { callLLM } from '@/lib/llm'
import { createFirestoreExtractionProposalStore } from '@/lib/boq-extraction-proposal-store'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { buildDurableExtractionReviewResponse, createExtractionReviewHandler, type ExtractionReviewRouteContext } from './review-api'

const REVIEW_TIMEOUT_MS = 20_000

const handler = createExtractionReviewHandler({
  authenticate: auth,
  getReadyImport: (boqId, runId) => createFirestoreExtractionStore(getDb()).getReadyImport(boqId, runId),
  getSourceRows: (boqId, runId) => createFirestoreExtractionStore(getDb()).getSourceRows(boqId, runId),
  getReviewState: (boqId, runId) => createFirestoreExtractionProposalStore(getDb()).getReviewState(boqId, runId),
  acquireReviewLease: (boqId, runId, requestKey, leaseId, ttl, force) => createFirestoreExtractionProposalStore(getDb()).acquireReviewLease(boqId, runId, requestKey, leaseId, ttl, force),
  completeReviewLease: (boqId, runId, leaseId, status, proposals, refreshedSourceRowIds, validationSummary) => createFirestoreExtractionProposalStore(getDb()).completeReviewLease(boqId, runId, leaseId, status, proposals, refreshedSourceRowIds, validationSummary),
  failReviewLease: (boqId, runId, leaseId, failureCode, retryDelayMs, preservedProposals, refreshedSourceRowIds, validationSummary) => createFirestoreExtractionProposalStore(getDb()).failReviewLease(boqId, runId, leaseId, failureCode, retryDelayMs, preservedProposals, refreshedSourceRowIds, validationSummary),
  createLeaseId: () => crypto.randomUUID(),
  getSettings: () => getDocument<WorkspaceSettings>('settings', 'workspace'),
  // JSON mode; callLLM retries as plain text if a model rejects response_format.
  callProvider: (messages, provider, model, signal) => callLLM(messages, provider, model, signal, { responseFormat: 'json', temperature: 0 }),
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
    return Response.json(buildDurableExtractionReviewResponse({ imported, sourceRows, stored }))
  } catch {
    return Response.json({ error: 'Extraction review could not be loaded' }, { status: 500 })
  }
}
