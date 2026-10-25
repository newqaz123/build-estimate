import { auth } from '@/lib/auth'
import {
  ACTIONABLE_REVIEW_PROMPT_VERSION,
  generateActionableReview,
  type GenerateActionableReviewResult,
} from '@/lib/actionable-review-projection'
import {
  createFirestoreActionableReviewStorage,
  type ActionableReviewStorage,
} from '@/lib/actionable-review-storage'
import {
  createActionableReviewProviderCall,
  type LlmCall,
} from '@/lib/llm'
import type { ActionableReviewCostEstimator, ActionableReviewProviderCall } from '@/lib/actionable-review-ai'
import type { ExtractionProposalAudit } from '@/lib/boq-extraction-acceptance'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import type { ValidatedProposal } from '@/lib/boq-extraction-proposals'
import type { Boq } from '@/lib/boq-schema'
import {
  createFirestoreCatalogConversionRuleStore,
} from '@/lib/catalog-conversion-storage'
import type { HumanApprovedCatalogConversionRule } from '@/lib/catalog-conversion'
import {
  createFirestoreCatalogMappingCacheStore,
  type CatalogMappingCacheStore,
} from '@/lib/catalog-mapping-cache-storage'
import type { CatalogShortlistCatalogEntry } from '@/lib/catalog-candidate-shortlist'
import { createFirestoreExtractionStore } from '@/lib/boq-extraction-storage'
import {
  createFirestoreExtractionProposalStore,
  type ExtractionProposalReviewState,
} from '@/lib/boq-extraction-proposal-store'
import { getCollection, getDb, getDocument } from '@/lib/db'
import type { StandardEntry } from '@/lib/standard-schema'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import {
  DEFAULT_SETTINGS,
  fromStoredSettings,
  type StoredWorkspaceSettings,
} from '@/lib/settings-storage'

export type ActionableReviewRouteContext = {
  params: Promise<{ id: string; runId: string }>
}

type Authenticate = () => Promise<{ user?: { id?: string | null } | null } | null>

export interface ActionableReviewRouteDependencies {
  authenticate: Authenticate
  getBoq(boqId: string): Promise<Boq | null>
  getReadyImport(boqId: string, runId: string): Promise<{ boq: Boq; run: BoqExtractionRun } | null>
  getSourceRows(boqId: string, runId: string): Promise<BoqSourceRowV3[]>
  getSettings(): Promise<WorkspaceSettings | null>
  listCatalog(): Promise<CatalogShortlistCatalogEntry[]>
  listConversionRules(): Promise<HumanApprovedCatalogConversionRule[]>
  getProposals(boqId: string, runId: string): Promise<ValidatedProposal[]>
  getAudits(boqId: string, runId: string): Promise<ExtractionProposalAudit[]>
  storage: ActionableReviewStorage
  mappingCache: CatalogMappingCacheStore
  callProvider: ActionableReviewProviderCall
  estimateCostMinor: ActionableReviewCostEstimator
  workspaceScope?: string
  now?: () => string
  /** Test spies — production leaves these undefined so forbidden writes cannot happen. */
  mutateBoq?: (boqId: string) => Promise<void>
  mutateCatalog?: () => Promise<void>
  mutateProposalLifecycle?: () => Promise<void>
  mutateApprovalState?: (boqId: string) => Promise<void>
}

function validPathId(value: string): boolean {
  return value.trim() !== '' && !value.includes('/') && value.length <= 240
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

function actorId(session: { user?: { id?: string | null } | null } | null): string | null {
  const id = session?.user?.id
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null
}

const FORBIDDEN_BODY_KEYS = new Set([
  'snapshot',
  'review',
  'metrics',
  'pricing',
  'factor',
  'conversionFactor',
  'catalogId',
  'catalogIds',
  'rate',
  'quantity',
  'total',
  'amount',
  'price',
  'cost',
  'extractedItem',
  'normalization',
  'actionableItemSuggestions',
  'sourceTotalDifference',
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function isBoqSnapshot(value: unknown): value is Boq {
  return isPlainRecord(value)
    && Array.isArray(value.sections)
    && typeof value.totalItems === 'number'
    && typeof value.grandTotal === 'number'
}

/**
 * Fail-closed ExtractionProposalAudit guard (mirrors store semantics).
 * Never treats undo/reopen events or bare `audits` bags as audits.
 */
export function isExtractionProposalAudit(value: unknown): value is ExtractionProposalAudit {
  if (!isPlainRecord(value)) return false
  if (typeof value.proposalId !== 'string' || value.proposalId.trim() === '') return false
  if (typeof value.auditId !== 'string' || value.auditId.trim() === '') return false
  if (typeof value.extractionRunId !== 'string' || value.extractionRunId.trim() === '') return false
  if (value.status !== 'accepted' && value.status !== 'rejected' && value.status !== 'skipped') {
    return false
  }
  if (!Array.isArray(value.targetItemIds)) return false
  if (!Array.isArray(value.sourceRowIds)) return false
  if (typeof value.actorId !== 'string' || value.actorId.trim() === '') return false
  if (typeof value.timestamp !== 'string' || value.timestamp.trim() === '') return false
  if (value.status === 'accepted' && !isBoqSnapshot(value.resultBoq)) return false
  // Undo/reopen events carry status "undone"/"reopened" and are rejected above.
  return true
}

/**
 * Production audit loader input shape: ExtractionProposalReviewState.auditEvents only.
 * Never reads a fictional `state.audits` field.
 */
export function extractAuditsFromReviewState(state: unknown): ExtractionProposalAudit[] {
  if (!isPlainRecord(state)) return []
  const events = state.auditEvents
  if (!Array.isArray(events)) return []
  const audits: ExtractionProposalAudit[] = []
  for (const event of events) {
    if (isExtractionProposalAudit(event)) {
      audits.push(event)
    }
  }
  return audits
}

export function createGetAuditsFromReviewState(
  getReviewState: (boqId: string, runId: string) => Promise<unknown>,
): ActionableReviewRouteDependencies['getAudits'] {
  return async (boqId, runId) => {
    const state = await getReviewState(boqId, runId)
    return extractAuditsFromReviewState(state)
  }
}

/**
 * Production settings decode path.
 * Legacy docs without actionableReview default safely; invalid/partial sections throw
 * (fail closed) instead of returning a half-typed object that TypeErrors later.
 */
export function decodeActionableReviewSettingsDoc(
  stored: StoredWorkspaceSettings | null | undefined,
): WorkspaceSettings {
  return fromStoredSettings(stored)
}

async function readPostBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text()
  if (text.trim() === '') return {}
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return jsonError('Request body must be valid JSON.', 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('Request body must be a JSON object.', 400)
  }
  const record = body as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) {
      return jsonError('Client-authored authoritative fields are not allowed.', 400)
    }
    // Only allow empty/no-op bodies in shadow generation.
    if (key !== 'mode') {
      return jsonError('Unsupported actionable review request field.', 400)
    }
  }
  if (record.mode !== undefined && record.mode !== 'shadow' && record.mode !== 'focused') {
    return jsonError('Invalid actionable review mode.', 400)
  }
  return record
}

function stageAllowsPost(stage: WorkspaceSettings['actionableReview']['stage']): boolean {
  return stage === 'shadow'
    || stage === 'focused'
    || stage === 'add_and_match'
    || stage === 'default'
}

function defaultCostEstimator(): ActionableReviewCostEstimator {
  return ({ rows, maxPromptTokens }) => {
    // Conservative token-proxy estimate in minor currency units; never trusts model money.
    const approx = rows.length * 3 + Math.ceil(maxPromptTokens / 1000)
    return Math.max(0, Math.floor(approx))
  }
}

const EMPTY_AI_BATCH_SUMMARY = {
  cacheHitCount: 0,
  initialCallCount: 0,
  escalationCallCount: 0,
  estimatedCostMinor: 0,
  providerUnavailable: false,
} as const

export function createActionableReviewHandlers(dependencies: ActionableReviewRouteDependencies) {
  async function GET(
    _request: Request,
    context: ActionableReviewRouteContext,
  ): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!actorId(session)) return jsonError('Unauthorized', 401)

    const { id, runId } = await context.params
    if (![id, runId].every(validPathId)) {
      return jsonError('Invalid actionable review path', 400)
    }

    try {
      const imported = await dependencies.getReadyImport(id, runId)
      if (!imported) return jsonError('Extraction run not found', 404)
      // Read-only for all BOQ statuses including approved.
      void imported.boq.status

      const url = new URL(_request.url)
      const fingerprint = url.searchParams.get('fingerprint')
      if (!fingerprint || !/^sha256:[a-f0-9]{64}$/.test(fingerprint)) {
        return jsonError('fingerprint query parameter is required', 400)
      }

      const [snapshot, metrics] = await Promise.all([
        dependencies.storage.getSnapshot(id, runId, fingerprint),
        dependencies.storage.getMetrics(id, runId, fingerprint),
      ])
      if (!snapshot) return jsonError('Actionable review snapshot not found', 404)
      return Response.json({
        snapshot,
        metrics: metrics ?? null,
      })
    } catch (error) {
      console.error('Error loading actionable review snapshot:', error)
      return jsonError('Actionable review could not be loaded', 500)
    }
  }

  async function POST(
    request: Request,
    context: ActionableReviewRouteContext,
  ): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!actorId(session)) return jsonError('Unauthorized', 401)

    const { id, runId } = await context.params
    if (![id, runId].every(validPathId)) {
      return jsonError('Invalid actionable review path', 400)
    }

    const body = await readPostBody(request)
    if (body instanceof Response) return body

    try {
      const [imported, sourceRows, settingsDoc, catalog, conversionRules, proposals, audits] =
        await Promise.all([
          dependencies.getReadyImport(id, runId),
          dependencies.getSourceRows(id, runId),
          dependencies.getSettings(),
          dependencies.listCatalog(),
          dependencies.listConversionRules(),
          dependencies.getProposals(id, runId),
          dependencies.getAudits(id, runId),
        ])

      if (!imported) return jsonError('Extraction run not found', 404)

      const boq = imported.boq
      if (boq.status === 'approved') {
        return jsonError('Approved BOQs cannot be mutated.', 409)
      }

      const settings = settingsDoc ?? DEFAULT_SETTINGS
      if (!stageAllowsPost(settings.actionableReview.stage)) {
        return jsonError('Actionable review stage does not allow shadow generation.', 409)
      }

      const mode = body.mode === 'focused' ? 'focused' : 'shadow'
      const unitMap = settings.fuzzy?.unitMap ?? {}
      const modelVersion = settings.actionableReview.lowCostModel

      // Provider may still run before collision detection (cost-only inefficiency on
      // same-fingerprint retries). Response/state remain content-stable via bundle exists.
      const generated: GenerateActionableReviewResult = await generateActionableReview({
        extractionRunId: runId,
        run: imported.run,
        sourceRows,
        boq,
        proposals,
        audits,
        catalog,
        conversionRules,
        unitMap,
        settings: settings.actionableReview,
        workspaceScope: dependencies.workspaceScope ?? id,
        promptVersion: ACTIONABLE_REVIEW_PROMPT_VERSION,
        modelVersion,
        cache: dependencies.mappingCache,
        callProvider: dependencies.callProvider,
        estimateCostMinor: dependencies.estimateCostMinor,
        now: dependencies.now,
        mode,
      })

      // Atomic snapshot+metrics only. Never BOQ/catalog/proposal/approval.
      const bundle = await dependencies.storage.writeBundle(
        id,
        runId,
        generated.review,
        generated.metrics,
      )

      if (bundle.status === 'exists') {
        // Content-stable: return stored documents; NO model cache writes on collision.
        return Response.json(
          {
            snapshot: bundle.snapshot,
            metrics: bundle.metrics,
            idempotent: true,
            aiBatch: { ...EMPTY_AI_BATCH_SUMMARY },
          },
          { status: 200 },
        )
      }

      // Model advice is intentionally not written to the mapping cache; only an
      // explicit human approval may create approved mappings.

      // Guardrails for tests: production dependencies omit these mutators.
      void dependencies.mutateBoq
      void dependencies.mutateCatalog
      void dependencies.mutateProposalLifecycle
      void dependencies.mutateApprovalState

      return Response.json(
        {
          snapshot: bundle.snapshot,
          metrics: bundle.metrics,
          idempotent: false,
          aiBatch: {
            cacheHitCount: generated.aiBatch.cacheHitCount,
            initialCallCount: generated.aiBatch.initialCallCount,
            escalationCallCount: generated.aiBatch.escalationCallCount,
            estimatedCostMinor: generated.aiBatch.estimatedCostMinor,
            providerUnavailable: generated.aiBatch.providerUnavailable,
          },
        },
        { status: 201 },
      )
    } catch (error) {
      console.error('Error generating actionable review:', error)
      return jsonError('Actionable review could not be generated', 500)
    }
  }

  return { GET, POST }
}

function productionDependencies(): ActionableReviewRouteDependencies {
  // Lazy store accessors — avoid Firebase init at module import (keeps DI tests pure).
  const extractionStore = () => createFirestoreExtractionStore(getDb())
  const proposalStore = () => createFirestoreExtractionProposalStore(getDb())
  const conversionStore = () => createFirestoreCatalogConversionRuleStore(getDb())
  const mappingCache = () => createFirestoreCatalogMappingCacheStore(getDb())
  const storage = () => createFirestoreActionableReviewStorage(getDb())
  const callLLM: LlmCall = async (messages, provider, model, signal, options) => {
    const { callLLM: impl } = await import('@/lib/llm')
    return impl(messages, provider, model, signal, options)
  }

  const getAudits = createGetAuditsFromReviewState(async (boqId, runId) => {
    const state: ExtractionProposalReviewState | null =
      await proposalStore().getReviewState(boqId, runId)
    return state
  })

  return {
    authenticate: auth,
    async getBoq(boqId) {
      return getDocument<Boq>('boqs', boqId)
    },
    getReadyImport: (boqId, runId) => extractionStore().getReadyImport(boqId, runId),
    getSourceRows: (boqId, runId) => extractionStore().getSourceRows(boqId, runId),
    async getSettings() {
      const stored = await getDocument<StoredWorkspaceSettings>('settings', 'workspace')
      return decodeActionableReviewSettingsDoc(stored)
    },
    async listCatalog() {
      const standards = await getCollection<StandardEntry>('standards')
      return standards.map((entry) => ({
        id: entry.id,
        description: entry.description,
        unit: entry.unit,
        aliases: entry.aliases,
        archivedAt: entry.archivedAt,
      }))
    },
    async listConversionRules() {
      return conversionStore().list({ limit: 500 })
    },
    async getProposals(boqId, runId) {
      const state = await proposalStore().getReviewState(boqId, runId)
      return (state?.proposals ?? []) as ValidatedProposal[]
    },
    getAudits,
    get storage() {
      return storage()
    },
    get mappingCache() {
      return mappingCache()
    },
    callProvider: createActionableReviewProviderCall({ callLLM }),
    estimateCostMinor: defaultCostEstimator(),
  }
}

// Build production handlers with lazy store getters only — no eager getDb().
const handlers = createActionableReviewHandlers(productionDependencies())

/** Read-only snapshot/metrics fetch; allowed for approved BOQs. */
export async function GET(request: Request, context: ActionableReviewRouteContext) {
  return handlers.GET(request, context)
}

/**
 * Generate and persist shadow actionable-review projection.
 * Writes only snapshot/metrics/model-mapping-cache collections.
 */
export async function POST(request: Request, context: ActionableReviewRouteContext) {
  return handlers.POST(request, context)
}
