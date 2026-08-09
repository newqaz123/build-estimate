import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createActionableReviewHandlers,
  createGetAuditsFromReviewState,
  extractAuditsFromReviewState,
  isExtractionProposalAudit,
  type ActionableReviewRouteDependencies,
} from './route'
import {
  ACTIONABLE_REVIEW_PROMPT_VERSION,
  generateActionableReview,
} from '@/lib/actionable-review-projection'
import {
  createActionableReviewStorage,
  type ActionableReviewDocumentStore,
} from '@/lib/actionable-review-storage'
import type { ExtractionProposalAudit } from '@/lib/boq-extraction-acceptance'
import type { BoqExtractionRun } from '@/lib/boq-extraction-run'
import type { BoqSourceRowV3 } from '@/lib/boq-extraction-schema'
import { fingerprintCanonicalItem } from '@/lib/boq-extraction-proposals'
import type { Boq, BoqPricedItem } from '@/lib/boq-schema'
import type { CatalogMappingCacheStore } from '@/lib/catalog-mapping-cache-storage'
import type { ApprovedCatalogMapping } from '@/lib/catalog-mapping-cache'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { DEFAULT_SETTINGS } from '@/lib/settings-storage'
import { assertNoRawMetricContent } from '@/lib/actionable-review-metrics'

function cell(
  column: number,
  rawText: string,
): BoqSourceRowV3['rawCells'][number] {
  return {
    column,
    rawText,
    lines: [rawText],
    rowSpan: 1,
    columnSpan: 1,
    startRowOffset: 0,
    endRowOffset: 1,
    startColumnOffset: column,
    endColumnOffset: column + 1,
    columnHeader: false,
    rowHeader: false,
    rowSection: false,
    carried: false,
  }
}

function sourceRow(input: {
  id: string
  row: number
  desc: string
  unit?: string
  qty?: string
  rate?: string
  amount?: string
}): BoqSourceRowV3 {
  const headers = ['Description', 'Unit', 'Qty', 'Rate', 'Amount']
  const unit = input.unit ?? 'm3'
  const qty = input.qty ?? '2'
  const rate = input.rate ?? '50'
  const amount = input.amount ?? '100'
  return {
    id: input.id,
    page: 1,
    table: 0,
    row: input.row,
    section: 'Works',
    headers,
    rawCells: [
      cell(0, input.desc),
      cell(1, unit),
      cell(2, qty),
      cell(3, rate),
      cell(4, amount),
    ],
    rawText: `${input.desc} | ${unit} | ${qty} | ${rate} | ${amount}`,
    classification: 'item',
    confidence: 0.9,
    warnings: [],
  }
}

function runFor(rows: readonly BoqSourceRowV3[]): BoqExtractionRun {
  return {
    id: 'run-1',
    boqId: 'boq-1',
    contractVersion: 3,
    status: 'ready',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    stagingExpiresAt: null,
    sourceFile: { path: 'p', name: 'n.pdf', digest: 'sha256:x' },
    parser: { name: 'docling', contractVersion: 3, configFingerprint: 'sha256:p' },
    metadataCandidates: {
      vendor: { value: 'V', confidence: 1, source: 'f' },
      project: { value: 'P', confidence: 1, source: 'f' },
      date: { value: '2026-08-08', confidence: 1, source: 'f' },
      workType: { value: 'MEP', confidence: 1, source: 'f' },
    },
    metadataConfidence: { vendor: 1, project: 1, date: 1, workType: 1 },
    sourceRowCount: rows.length,
    sourceRowChecksum: 'sha256:rows',
    reconciliation: {
      itemTotal: 100,
      sourceTotal: 100,
      reconciled: true,
      difference: 0,
    },
    warnings: [],
    sections: [{ header: 'Works', items: [] }],
    totalItems: 0,
    aiReviewStatus: 'completed',
    reviewTargeting: { candidateRowIds: [], candidateCount: 0, unreconciled: false },
  }
}

function pricedItem(input: {
  id: string
  desc: string
  unit?: string
  qty?: number
  rate?: number
  total?: number
  sourceRowId?: string
}): BoqPricedItem {
  return {
    id: input.id,
    desc: input.desc,
    unit: input.unit ?? 'm3',
    qty: input.qty ?? 2,
    rate: input.rate ?? 50,
    total: input.total ?? 100,
    type: 'unit',
    costComponent: 'combined',
    stdStatus: 'unmatched',
    entryOrigin: 'docling',
    ...(input.sourceRowId ? { sourceRowId: input.sourceRowId } : {}),
  }
}

function boq(
  status: Boq['status'] = 'review',
  items: BoqPricedItem[] = [
    pricedItem({ id: 'existing', desc: 'Existing item', unit: 'm', qty: 1, rate: 1, total: 1 }),
  ],
): Boq {
  return {
    id: 'boq-1',
    project: 'P',
    vendor: 'V',
    workType: 'MEP',
    date: '2026-08-08',
    totalItems: items.length,
    grandTotal: items.reduce((sum, item) => sum + item.total, 0),
    status,
    stdStatus: 'none',
    sections: [{ header: 'Works', items }],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    sourceTotal: 100,
  }
}

function memoryDocuments(): ActionableReviewDocumentStore & {
  docs: Map<string, Record<string, unknown>>
} {
  const docs = new Map<string, Record<string, unknown>>()
  return {
    docs,
    async get(path) {
      const data = docs.get(path)
      return data ? { path, data: structuredClone(data) } : null
    },
    async setBundleIfAbsent(input) {
      const hasSnap = docs.has(input.snapshotPath)
      const hasMetrics = docs.has(input.metricsPath)
      if (hasSnap || hasMetrics) {
        if (!hasSnap || !hasMetrics) throw new Error('Incomplete bundle')
        return {
          status: 'exists',
          snapshotData: structuredClone(docs.get(input.snapshotPath)!),
          metricsData: structuredClone(docs.get(input.metricsPath)!),
        }
      }
      docs.set(input.snapshotPath, structuredClone(input.snapshotData))
      docs.set(input.metricsPath, structuredClone(input.metricsData))
      return { status: 'created' }
    },
  }
}

function memoryMappingCache(): CatalogMappingCacheStore & {
  modelPuts: Array<{ key: string; mapping: ApprovedCatalogMapping }>
  humanPuts: string[]
} {
  const store = new Map<string, ApprovedCatalogMapping>()
  const modelPuts: Array<{ key: string; mapping: ApprovedCatalogMapping }> = []
  const humanPuts: string[] = []
  return {
    modelPuts,
    humanPuts,
    async get(key) {
      return store.get(key) ?? null
    },
    async put(key) {
      humanPuts.push(key)
      throw new Error('route must not human-approve mappings')
    },
    async putModel(key, mapping) {
      modelPuts.push({ key, mapping })
      store.set(key, mapping)
    },
    async remove() {
      throw new Error('route must not remove mappings')
    },
  }
}

function settings(stage: WorkspaceSettings['actionableReview']['stage'] = 'shadow'): WorkspaceSettings {
  return {
    ...DEFAULT_SETTINGS,
    actionableReview: {
      ...DEFAULT_SETTINGS.actionableReview,
      stage,
      lowCostModel: 'gpt-4o-mini',
      maxEstimatedCostMinor: 0,
    },
  }
}

function context(id = 'boq-1', runId = 'run-1') {
  return { params: Promise.resolve({ id, runId }) }
}

function deps(
  overrides: Partial<ActionableReviewRouteDependencies> & {
    boqStatus?: Boq['status']
    stage?: WorkspaceSettings['actionableReview']['stage']
    rows?: BoqSourceRowV3[]
    currentBoq?: Boq
  } = {},
): ActionableReviewRouteDependencies & {
  mutations: {
    boq: number
    catalog: number
    proposal: number
    approval: number
  }
  documents: ReturnType<typeof memoryDocuments>
  mappingCache: ReturnType<typeof memoryMappingCache>
} {
  const rows = overrides.rows ?? [
    sourceRow({ id: 'row-1', row: 1, desc: 'Ready mix concrete C25', amount: '100' }),
  ]
  const documents = memoryDocuments()
  const mappingCache = memoryMappingCache()
  const mutations = { boq: 0, catalog: 0, proposal: 0, approval: 0 }
  const currentBoq = overrides.currentBoq ?? boq(overrides.boqStatus ?? 'review')
  const run = runFor(rows)

  const base: ActionableReviewRouteDependencies = {
    authenticate: async () => ({ user: { id: 'user-1' } }),
    getBoq: async () => currentBoq,
    getReadyImport: async () => ({ boq: currentBoq, run }),
    getSourceRows: async () => rows,
    getSettings: async () => settings(overrides.stage ?? 'shadow'),
    listCatalog: async () => [
      { id: 'std-1', description: 'Ready mix concrete C25', unit: 'm3', aliases: [] },
    ],
    listConversionRules: async () => [],
    getProposals: async () => [],
    getAudits: async () => [],
    storage: createActionableReviewStorage(documents),
    mappingCache,
    callProvider: async () => {
      throw new Error('budget zero path should avoid provider')
    },
    estimateCostMinor: () => 0,
    workspaceScope: 'ws-1',
    now: () => '2026-08-08T12:00:00.000Z',
    mutateBoq: async () => {
      mutations.boq += 1
    },
    mutateCatalog: async () => {
      mutations.catalog += 1
    },
    mutateProposalLifecycle: async () => {
      mutations.proposal += 1
    },
    mutateApprovalState: async () => {
      mutations.approval += 1
    },
  }

  return {
    ...base,
    ...overrides,
    mutations,
    documents,
    mappingCache: (overrides.mappingCache as ReturnType<typeof memoryMappingCache>) ?? mappingCache,
  }
}

function acceptedAuditFor(item: BoqPricedItem, sourceRowId: string): ExtractionProposalAudit {
  const itemId = item.id
  if (!itemId) throw new Error('fixture item requires id')
  const resultBoq = boq('review', [item])
  return {
    auditId: 'audit-1',
    proposalId: 'proposal-1',
    extractionRunId: 'run-1',
    status: 'accepted',
    actorId: 'user-1',
    timestamp: '2026-08-08T00:00:00.000Z',
    operation: 'insert_missing_item',
    targetItemIds: [itemId],
    affectedItemFingerprints: {
      [itemId]: fingerprintCanonicalItem(item),
    },
    confidence: 1,
    explanation: 'accepted',
    sourceRowIds: [sourceRowId],
    sourceRefs: [{ sourceRowId, page: 1, table: 0, row: 1 }],
    proposedItems: [
      {
        id: itemId,
        desc: item.desc,
        unit: item.unit,
        qty: item.qty,
        rate: item.rate,
        total: item.total,
        costComponent: 'combined',
        pricingRole: 'standard',
        sourceRowIds: [sourceRowId],
        entryOrigin: 'ai_accepted',
      },
    ],
    beforeSections: [],
    beforeSectionsFingerprint: 'sha256:' + '1'.repeat(64),
    afterSections: resultBoq.sections,
    afterSectionsFingerprint: 'sha256:' + '2'.repeat(64),
    resultBoq,
    sequence: 1,
  }
}

test('GET is read-only and allowed for approved BOQs', async () => {
  const d = deps({ boqStatus: 'approved' })
  const { GET } = createActionableReviewHandlers(d)

  const mutable = deps({ boqStatus: 'review' })
  const seedHandlers = createActionableReviewHandlers(mutable)
  const seed = await seedHandlers.POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(seed.status, 201)
  const seeded = await seed.json() as { snapshot: { id: string }; metrics: unknown }
  assert.doesNotThrow(() => assertNoRawMetricContent(seeded.metrics))

  for (const [path, data] of mutable.documents.docs.entries()) {
    d.documents.docs.set(path, data)
  }

  const response = await GET(
    new Request(`http://localhost/api?fingerprint=${seeded.snapshot.id}`),
    context(),
  )
  assert.equal(response.status, 200)
  const body = await response.json() as { snapshot: { id: string } }
  assert.equal(body.snapshot.id, seeded.snapshot.id)
  assert.equal(d.mutations.boq, 0)
  assert.equal(d.mutations.approval, 0)
})

test('POST rejects approved BOQs and stage off', async () => {
  const approved = createActionableReviewHandlers(deps({ boqStatus: 'approved' }))
  const approvedRes = await approved.POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(approvedRes.status, 409)

  const off = createActionableReviewHandlers(deps({ stage: 'off' }))
  const offRes = await off.POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(offRes.status, 409)
})

test('POST rejects client-authored authoritative snapshot/pricing/catalog fields', async () => {
  const { POST } = createActionableReviewHandlers(deps())
  for (const body of [
    { snapshot: { id: 'x' } },
    { pricing: { total: '1' } },
    { catalogId: 'std-1' },
    { conversionFactor: '2' },
    { rate: '10' },
    { cost: 5 },
  ]) {
    const response = await POST(
      new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      context(),
    )
    assert.equal(response.status, 400, JSON.stringify(body))
  }
})

test('POST writes only snapshot/metrics/cache and never mutates BOQ/catalog/proposals/approval', async () => {
  const d = deps()
  const { POST } = createActionableReviewHandlers(d)
  const first = await POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(first.status, 201)
  const firstBody = await first.json() as {
    snapshot: { id: string; mode: string }
    metrics: unknown
    aiBatch: { estimatedCostMinor: number }
  }
  assert.equal(firstBody.snapshot.mode, 'shadow')
  assert.doesNotThrow(() => assertNoRawMetricContent(firstBody.metrics))
  assert.equal(JSON.stringify(firstBody.metrics).includes('Ready mix'), false)
  assert.equal(JSON.stringify(firstBody.metrics).includes('pdf'), false)

  const paths = [...d.documents.docs.keys()]
  assert.ok(paths.some((path) => path.includes('/actionableReviewSnapshots/')))
  assert.ok(paths.some((path) => path.includes('/actionableReviewMetrics/')))
  assert.ok(paths.every((path) =>
    path.includes('/actionableReviewSnapshots/')
    || path.includes('/actionableReviewMetrics/'),
  ))
  // Atomic pair always co-present.
  assert.equal(
    paths.filter((path) => path.includes('/actionableReviewSnapshots/')).length,
    paths.filter((path) => path.includes('/actionableReviewMetrics/')).length,
  )

  assert.equal(d.mutations.boq, 0)
  assert.equal(d.mutations.catalog, 0)
  assert.equal(d.mutations.proposal, 0)
  assert.equal(d.mutations.approval, 0)
  assert.equal(d.mappingCache.humanPuts.length, 0)

  const second = await POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(second.status, 200)
  const secondBody = await second.json() as { idempotent: boolean; snapshot: { id: string } }
  assert.equal(secondBody.idempotent, true)
  assert.equal(secondBody.snapshot.id, firstBody.snapshot.id)
})

test('same-fingerprint POST returns stored body/metrics and skips model cache writes', async () => {
  let generation = 0
  const d = deps({
    rows: [
      // Ambiguous description so AI path can run when budget allows.
      sourceRow({ id: 'row-1', row: 1, desc: 'Ambiguous structural works package', unit: 'ls', amount: '100' }),
    ],
    getSettings: async () => ({
      ...settings('shadow'),
      actionableReview: {
        ...settings('shadow').actionableReview,
        maxEstimatedCostMinor: 500,
      },
    }),
    estimateCostMinor: () => 10,
    callProvider: async ({ rows }) => {
      generation += 1
      return {
        advice: rows.map((row) => ({
          sourceRowId: row.sourceRowId,
          // uncertain keeps provider path open without requiring shortlist allowlist hits
          decision: 'uncertain' as const,
          confidence: generation === 1 ? 0.11 : 0.99,
          reason: generation === 1 ? 'first-generation' : 'second-generation-must-not-leak',
        })),
      }
    },
    listCatalog: async () => [
      { id: 'std-1', description: 'Catalog item A', unit: 'ls', aliases: [] },
      { id: 'std-2', description: 'Catalog item B', unit: 'ls', aliases: [] },
    ],
  })
  const { POST } = createActionableReviewHandlers(d)

  const first = await POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(first.status, 201)
  const firstBody = await first.json() as {
    snapshot: {
      id: string
      actionableItemSuggestions: Array<{ aiAdvice?: { reason?: string; confidence?: number } }>
    }
    metrics: unknown
  }
  const firstCacheCount = d.mappingCache.modelPuts.length
  assert.ok(firstBody.snapshot.actionableItemSuggestions.some(
    (item) => item.aiAdvice?.reason === 'first-generation',
  ))

  const second = await POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(second.status, 200)
  const secondBody = await second.json() as {
    idempotent: boolean
    snapshot: typeof firstBody.snapshot
    metrics: unknown
  }
  assert.equal(secondBody.idempotent, true)
  assert.deepEqual(secondBody.snapshot, firstBody.snapshot)
  assert.deepEqual(secondBody.metrics, firstBody.metrics)
  assert.equal(
    JSON.stringify(secondBody.snapshot).includes('second-generation-must-not-leak'),
    false,
  )
  assert.equal(d.mappingCache.modelPuts.length, firstCacheCount)
  assert.equal(d.mutations.boq, 0)
  assert.equal(d.mutations.proposal, 0)
  assert.equal(d.mutations.catalog, 0)
  assert.equal(d.mutations.approval, 0)
})

test('production audit loader reads auditEvents only and accepted audit reaches reconciliation', async () => {
  const item = pricedItem({
    id: 'item-audit',
    desc: 'Ready mix concrete C25',
    unit: 'm3',
    qty: 2,
    rate: 50,
    total: 100,
    // no sourceRowId — representation must come from accepted audit
  })
  const audit = acceptedAuditFor(item, 'row-1')
  const undoEvent = {
    eventId: 'undo-1',
    proposalId: 'proposal-1',
    extractionRunId: 'run-1',
    status: 'undone',
    actorId: 'user-1',
    timestamp: '2026-08-08T01:00:00.000Z',
    sourceRowIds: ['row-1'],
    sourceRefs: [{ sourceRowId: 'row-1', page: 1, table: 0, row: 1 }],
    beforeSections: [],
    beforeSectionsFingerprint: 'sha256:' + '3'.repeat(64),
    afterSections: [],
    afterSectionsFingerprint: 'sha256:' + '4'.repeat(64),
    resultTotalItems: 0,
    resultGrandTotal: 0,
  }
  const realisticState = {
    proposals: [],
    proposalStatuses: {},
    // Realistic ExtractionProposalReviewState shape — never `audits`.
    auditEvents: [audit, undoEvent],
    reviewRun: { status: 'completed' },
    // Poison field must be ignored.
    audits: [{ status: 'accepted', proposalId: 'poison' }],
  }

  assert.equal(isExtractionProposalAudit(audit), true)
  assert.equal(isExtractionProposalAudit(undoEvent), false)
  const extracted = extractAuditsFromReviewState(realisticState)
  assert.equal(extracted.length, 1)
  assert.equal(extracted[0]!.auditId, 'audit-1')
  assert.equal(extractAuditsFromReviewState({ audits: [audit] }).length, 0)

  const getAudits = createGetAuditsFromReviewState(async () => realisticState)
  const currentBoq = boq('review', [item])
  const rows = [
    sourceRow({ id: 'row-1', row: 1, desc: 'Ready mix concrete C25', amount: '100' }),
  ]
  const d = deps({
    currentBoq,
    rows,
    getAudits,
  })
  const { POST } = createActionableReviewHandlers(d)
  const response = await POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.equal(response.status, 201)
  const body = await response.json() as {
    snapshot: {
      representedRows: Array<{ sourceRowIds: string[]; reason: string; boqItemId: string }>
      actionableItemSuggestions: Array<{ sourceRowIds: string[] }>
    }
  }
  assert.ok(
    body.snapshot.representedRows.some(
      (entry) =>
        entry.sourceRowIds.includes('row-1')
        && entry.reason === 'accepted_audit'
        && entry.boqItemId === 'item-audit',
    ),
    'accepted audit from auditEvents must reach reconciliation',
  )
  assert.ok(
    !body.snapshot.actionableItemSuggestions.some((entry) => entry.sourceRowIds.includes('row-1')),
  )
  assert.equal(d.mutations.proposal, 0)
  assert.equal(d.mutations.boq, 0)
})

test('POST validates opaque path ids fail closed', async () => {
  const { POST, GET } = createActionableReviewHandlers(deps())
  const badPost = await POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context('../evil', 'run-1'),
  )
  assert.equal(badPost.status, 400)

  const badGet = await GET(
    new Request('http://localhost/api?fingerprint=not-a-hash'),
    context(),
  )
  assert.equal(badGet.status, 400)
})

test('unauthorized requests are rejected', async () => {
  const d = deps({
    authenticate: async () => null,
  })
  const { GET, POST } = createActionableReviewHandlers(d)
  assert.equal(
    (await GET(new Request('http://localhost/api?fingerprint=' + 'sha256:' + 'a'.repeat(64)), context())).status,
    401,
  )
  assert.equal(
    (await POST(new Request('http://localhost/api', { method: 'POST', body: '{}' }), context())).status,
    401,
  )
})

test('provider failure still persists deterministic local shadow fallback', async () => {
  const d = deps({
    stage: 'shadow',
    callProvider: async () => {
      throw new Error('provider boom')
    },
    estimateCostMinor: () => 5,
    getSettings: async () => ({
      ...settings('shadow'),
      actionableReview: {
        ...settings('shadow').actionableReview,
        maxEstimatedCostMinor: 100,
      },
    }),
  })
  const { POST } = createActionableReviewHandlers(d)
  const response = await POST(
    new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    context(),
  )
  assert.ok(response.status === 201 || response.status === 200)
  const body = await response.json() as {
    snapshot: { actionableItemSuggestions: unknown[] }
    metrics: unknown
    aiBatch: { providerUnavailable: boolean }
  }
  assert.ok(body.snapshot.actionableItemSuggestions.length >= 1)
  assert.doesNotThrow(() => assertNoRawMetricContent(body.metrics))
})

test('projection helper stays independent of proposal grouping (route-level smoke)', async () => {
  const rows = [
    sourceRow({ id: 'row-1', row: 1, desc: 'Ready mix concrete C25', amount: '100' }),
    sourceRow({ id: 'row-2', row: 2, desc: 'High yield rebar', unit: 'kg', amount: '200' }),
  ]
  const left = await generateActionableReview({
    extractionRunId: 'run-1',
    run: runFor(rows),
    sourceRows: rows,
    boq: boq('review'),
    proposals: [],
    audits: [],
    catalog: [{ id: 'std-1', description: 'Ready mix concrete C25', unit: 'm3' }],
    conversionRules: [],
    unitMap: {},
    settings: settings('shadow').actionableReview,
    workspaceScope: 'ws',
    promptVersion: ACTIONABLE_REVIEW_PROMPT_VERSION,
    modelVersion: 'gpt-4o-mini',
    cache: memoryMappingCache(),
    callProvider: async () => ({ advice: [] }),
    estimateCostMinor: () => 0,
    now: () => '2026-08-08T12:00:00.000Z',
  })
  assert.ok(left.review.id.startsWith('sha256:'))
  assert.equal(left.review.mode, 'shadow')
})
