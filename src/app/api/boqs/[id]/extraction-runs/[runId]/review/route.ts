import { auth } from '@/lib/auth'
import { createFirestoreExtractionStore } from '@/lib/boq-extraction-storage'
import { getDb, getDocument } from '@/lib/db'
import { callLLM } from '@/lib/llm'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { createExtractionReviewHandler, type ExtractionReviewRouteContext } from './review-api'

const REVIEW_TIMEOUT_MS = 20_000

const handler = createExtractionReviewHandler({
  authenticate: auth,
  getReadyImport: (boqId, runId) => createFirestoreExtractionStore(getDb()).getReadyImport(boqId, runId),
  getSourceRows: (boqId, runId) => createFirestoreExtractionStore(getDb()).getSourceRows(boqId, runId),
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
