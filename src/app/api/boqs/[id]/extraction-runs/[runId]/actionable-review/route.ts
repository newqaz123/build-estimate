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
import { createFirestoreExtractionProposalStore } from '@/lib/boq-extraction-proposal-store'
import { getCollection, getDb, getDocument } from '@/lib/db'
import type { StandardEntry } from '@/lib/standard-schema'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { DEFAULT_SETTINGS } from '@/lib/settings-storage'

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

      // Persist only snapshot/metrics (+ optional model mapping cache advice).
      // Never touch BOQ sections/items, catalog standards, proposal lifecycle, or approval.
      const snapshotWrite = await dependencies.storage.writeSnapshot(id, runId, generated.review)
      const metricsWrite = await dependencies.storage.writeMetrics(id, runId, generated.metrics)

      for (const write of generated.modelCacheWrites) {
        try {
          await dependencies.mappingCache.putModel(write.key, write.mapping)
        } catch {
          // Model cache is best-effort advice only; never fail the shadow projection.
        }
      }

      // Guardrails for tests: production dependencies omit these mutators.
      void dependencies.mutateBoq
      void dependencies.mutateCatalog
      void dependencies.mutateProposalLifecycle
      void dependencies.mutateApprovalState

      const existing = snapshotWrite === 'exists' || metricsWrite === 'exists'
      return Response.json(
        {
          snapshot: generated.review,
          metrics: generated.metrics,
          idempotent: existing,
          aiBatch: {
            cacheHitCount: generated.aiBatch.cacheHitCount,
            initialCallCount: generated.aiBatch.initialCallCount,
            escalationCallCount: generated.aiBatch.escalationCallCount,
            estimatedCostMinor: generated.aiBatch.estimatedCostMinor,
            providerUnavailable: generated.aiBatch.providerUnavailable,
          },
        },
        { status: existing ? 200 : 201 },
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
  const callLLM: LlmCall = async (messages, provider, model, signal) => {
    const { callLLM: impl } = await import('@/lib/llm')
    return impl(messages, provider, model, signal)
  }

  return {
    authenticate: auth,
    async getBoq(boqId) {
      return getDocument<Boq>('boqs', boqId)
    },
    getReadyImport: (boqId, runId) => extractionStore().getReadyImport(boqId, runId),
    getSourceRows: (boqId, runId) => extractionStore().getSourceRows(boqId, runId),
    async getSettings() {
      return getDocument<WorkspaceSettings>('settings', 'workspace')
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
    async getAudits(boqId, runId) {
      const state = await proposalStore().getReviewState(boqId, runId)
      const audits = state && 'audits' in state
        ? (state as { audits?: ExtractionProposalAudit[] }).audits
        : undefined
      return audits ?? []
    },
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
