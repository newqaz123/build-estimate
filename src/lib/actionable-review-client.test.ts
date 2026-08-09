import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createActionableReviewClient,
  nextPendingSuggestionId,
  type ActionableReviewClient,
  type ActionableReviewTransport,
  type ActionableReviewTransportRequest,
  type ActionableReviewTransportResponse,
} from './actionable-review-client'
import {
  actionableReviewReducer,
  initialActionableReviewState,
  normalizeActionableReviewResponse,
  type ActionableReviewAction,
  type ActionableReviewState,
  type ActionableReviewVersionScope,
} from './actionable-review-state'
import type { ActionableReview } from './actionable-review-projection'

const FINGERPRINT = 'sha256:' + 'a'.repeat(64)

function validVersions() {
  return {
    extractionFingerprint: 'sha256:e',
    boqSectionsFingerprint: 'sha256:b',
    catalogFingerprint: 'sha256:c',
    conversionFingerprint: 'sha256:v',
    promptVersion: 'actionable-review-ai-v1',
  }
}

function validSnapshot(): ActionableReview {
  return {
    id: FINGERPRINT,
    extractionRunId: 'run-1',
    mode: 'shadow',
    generatedAt: '2026-08-08T12:00:00.000Z',
    versions: validVersions(),
    actionableItemSuggestions: [
      {
        id: 'sug-1',
        extractionRunId: 'run-1',
        sourceRowIds: ['row-1'],
        sourceRefs: [{ page: 1, table: 0, row: 1 }],
        rowRole: 'priced_item',
        deterministicReasons: ['structural_item'],
        suggestedSectionIndex: 0,
        extractedItem: {
          description: 'Ready mix concrete',
          unit: 'm3',
          quantity: '2',
          materialRate: '50',
          labourRate: '0',
          total: '100',
        },
        catalogCandidates: [
          {
            catalogId: 'std-1',
            description: 'Concrete C25',
            unit: 'm3',
            matchKind: 'exact',
            score: 100,
          },
        ],
        status: 'pending',
        versions: validVersions(),
      },
    ],
    dismissedEvidence: [],
    representedRows: [],
    validationSummary: {
      rawRowCount: 1,
      actionableCount: 1,
      dismissedCount: 0,
      representedCount: 0,
      locallyPreparedCatalogCount: 0,
      aiReviewedCount: 0,
      sourceTotalDifference: '0',
      rejectedReasonCounts: {},
    },
  }
}

const expectedScope: ActionableReviewVersionScope = {
  extractionFingerprint: 'sha256:e',
  boqSectionsFingerprint: 'sha256:b',
  catalogFingerprint: 'sha256:c',
  conversionFingerprint: 'sha256:v',
}

interface Harness {
  client: ActionableReviewClient
  state: () => ActionableReviewState
  dispatch: (action: ActionableReviewAction) => void
  transport: ActionableReviewTransport & {
    calls: ActionableReviewTransportRequest[]
    setResponse(handler: (req: ActionableReviewTransportRequest) => Promise<ActionableReviewTransportResponse>): void
  }
  unauthorized: () => number
}

function createHarness(overrides: {
  readOnly?: boolean
  getExpectedVersions?: () => ActionableReviewVersionScope | null
  initialState?: ActionableReviewState
} = {}): Harness {
  let state = overrides.initialState ?? initialActionableReviewState()
  const dispatch = (action: ActionableReviewAction) => {
    state = actionableReviewReducer(state, action)
  }
  let unauthorized = 0
  const calls: ActionableReviewTransportRequest[] = []
  let responder: (
    req: ActionableReviewTransportRequest,
  ) => Promise<ActionableReviewTransportResponse> = async () => ({
    status: 200,
    json: async () => ({ snapshot: validSnapshot() }),
  })

  const transport: ActionableReviewTransport & {
    calls: ActionableReviewTransportRequest[]
    setResponse(handler: (req: ActionableReviewTransportRequest) => Promise<ActionableReviewTransportResponse>): void
  } = {
    calls,
    setResponse(
      handler: (req: ActionableReviewTransportRequest) => Promise<ActionableReviewTransportResponse>,
    ) {
      responder = handler
    },
    async call(req: ActionableReviewTransportRequest): Promise<ActionableReviewTransportResponse> {
      calls.push(req)
      return responder(req)
    },
  }

  const client = createActionableReviewClient({
    transport,
    dispatch,
    getSnapshot: () => state.snapshot,
    getExpectedVersions: overrides.getExpectedVersions ?? (() => expectedScope),
    readOnly: overrides.readOnly,
    onUnauthorized: () => {
      unauthorized += 1
    },
    timeoutMs: 1_000,
  })

  return {
    client,
    state: () => state,
    dispatch,
    transport,
    unauthorized: () => unauthorized,
  }
}

test('load fetches and normalizes a stored snapshot', async () => {
  const harness = createHarness()
  harness.transport.setResponse(async () => ({
    status: 200,
    json: async () => ({ snapshot: validSnapshot(), metrics: null }),
  }))
  const result = await harness.client.load('boq-1', 'run-1', FINGERPRINT)
  assert.equal(result?.id, FINGERPRINT)
  assert.equal(harness.state().snapshot?.id, FINGERPRINT)
  assert.equal(harness.state().loading, false)
  assert.equal(harness.transport.calls.length, 1)
  assert.equal(harness.transport.calls[0]!.method, 'GET')
  assert.match(
    harness.transport.calls[0]!.path,
    /\/actionable-review\?fingerprint=/,
  )
})

test('load is allowed in approved/read-only context', async () => {
  const harness = createHarness({ readOnly: true })
  harness.transport.setResponse(async () => ({
    status: 200,
    json: async () => ({ snapshot: validSnapshot() }),
  }))
  const result = await harness.client.load('boq-1', 'run-1', FINGERPRINT)
  assert.equal(result?.id, FINGERPRINT)
  assert.equal(harness.state().snapshot?.id, FINGERPRINT)
})

test('load rejects malformed snapshots fail-closed', async () => {
  const harness = createHarness()
  const malformed = validSnapshot()
  ;(malformed.actionableItemSuggestions[0] as { status: string }).status = 'queued'
  harness.transport.setResponse(async () => ({
    status: 200,
    json: async () => ({ snapshot: malformed }),
  }))
  const result = await harness.client.load('boq-1', 'run-1', FINGERPRINT)
  assert.equal(result, null)
  assert.equal(harness.state().snapshot, null)
  assert.equal(harness.state().loading, false)
  assert.ok(harness.state().error)
})

test('load records an error on a non-ok response', async () => {
  const harness = createHarness()
  harness.transport.setResponse(async () => ({
    status: 404,
    json: async () => ({ error: 'not found' }),
  }))
  const result = await harness.client.load('boq-1', 'run-1', FINGERPRINT)
  assert.equal(result, null)
  assert.equal(harness.state().loading, false)
  assert.ok(harness.state().error)
})

test('load surfaces a 401 through onUnauthorized', async () => {
  const harness = createHarness()
  harness.transport.setResponse(async () => ({
    status: 401,
    json: async () => ({ error: 'unauthorized' }),
  }))
  const result = await harness.client.load('boq-1', 'run-1', FINGERPRINT)
  assert.equal(result, null)
  assert.equal(harness.unauthorized(), 1)
  assert.ok(harness.state().error)
})

test('latest-request-wins: a slower earlier load does not overwrite a newer one', async () => {
  const harness = createHarness()
  const newer = validSnapshot()
  const older = validSnapshot()
  older.id = 'sha256:' + 'b'.repeat(64)
  newer.id = 'sha256:' + 'c'.repeat(64)

  let firstResolve!: (value: ActionableReviewTransportResponse) => void
  const firstPromise = new Promise<ActionableReviewTransportResponse>(
    (resolve) => {
      firstResolve = resolve
    },
  )
  let callCount = 0
  harness.transport.setResponse(async () => {
    callCount += 1
    if (callCount === 1) return firstPromise
    return { status: 200, json: async () => ({ snapshot: newer }) }
  })

  const olderLoad = harness.client.load('boq-1', 'run-1', FINGERPRINT)
  const newerLoad = harness.client.load('boq-1', 'run-1', FINGERPRINT)

  const newerResult = await newerLoad
  assert.equal(newerResult?.id, newer.id)
  // Resolve the older (superseded) request last; its snapshot must be discarded.
  firstResolve({ status: 200, json: async () => ({ snapshot: older }) })
  const olderResult = await olderLoad
  assert.equal(olderResult, null)
  assert.equal(harness.state().snapshot?.id, newer.id)
})

test('generate posts and stores the generated snapshot', async () => {
  const harness = createHarness()
  harness.transport.setResponse(async () => ({
    status: 201,
    json: async () => ({ snapshot: validSnapshot(), idempotent: false }),
  }))
  const result = await harness.client.generate('boq-1', 'run-1', 'shadow')
  assert.equal(result?.id, FINGERPRINT)
  assert.equal(harness.state().snapshot?.id, FINGERPRINT)
  assert.equal(harness.transport.calls[0]!.method, 'POST')
  assert.match(harness.transport.calls[0]!.path, /\/actionable-review$/)
  assert.deepEqual(
    harness.transport.calls[0]!.body,
    { mode: 'shadow' },
  )
})

test('generate is refused in read-only/approved context', async () => {
  const harness = createHarness({ readOnly: true })
  const result = await harness.client.generate('boq-1', 'run-1', 'shadow')
  assert.equal(result, null)
  assert.equal(harness.transport.calls.length, 0)
  assert.ok(harness.state().error)
})

test('decide posts a bounded decision body and clears submitting state on success', async () => {
  const harness = createHarness({
    initialState: { ...initialActionableReviewState(), snapshot: validSnapshot(), selectedSuggestionId: 'sug-1' },
  })
  harness.transport.setResponse(async () => ({
    status: 200,
    json: async () => ({ ok: true }),
  }))
  const ok = await harness.client.decide('boq/1', 'run?1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
    note: 'covered',
  })
  assert.equal(ok, true)
  assert.equal(harness.state().submittingSuggestionId, null)
  assert.equal(harness.state().error, null)
  assert.equal(harness.transport.calls[0]!.method, 'POST')
  assert.match(
    harness.transport.calls[0]!.path,
    /\/api\/boqs\/boq%2F1\/extraction-runs\/run%3F1\/actionable-review\/sug-1\/decision$/,
  )
  assert.deepEqual(harness.transport.calls[0]!.body, {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
    note: 'covered',
  })
})

test('decide bounds add-to-BOQ fields and excludes immutable values', async () => {
  const harness = createHarness({
    initialState: {
      ...initialActionableReviewState(),
      snapshot: validSnapshot(),
      selectedSuggestionId: 'sug-1',
    },
  })
  harness.transport.setResponse(async () => ({
    status: 200,
    json: async () => ({ ok: true }),
  }))
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'add_pending_catalog',
    expectedFingerprint: FINGERPRINT,
    item: {
      sectionIndex: 2,
      desc: 'Corrected concrete',
      unit: 'm3',
      qty: 4,
      materialCost: 100,
      labourCost: 20,
      sourceRowIds: ['model-row'],
      extractedPricing: { total: '480' },
      conversionFactor: '2',
    } as never,
    correctionReason: 'x'.repeat(700),
  })
  assert.equal(ok, true)
  assert.deepEqual(harness.transport.calls[0]!.body, {
    action: 'add_pending_catalog',
    expectedFingerprint: FINGERPRINT,
    item: {
      sectionIndex: 2,
      desc: 'Corrected concrete',
      unit: 'm3',
      qty: 4,
      materialCost: 100,
      labourCost: 20,
    },
    correctionReason: 'x'.repeat(500),
  })
})

test('decide is refused in read-only context without transport', async () => {
  const harness = createHarness({
    readOnly: true,
    initialState: { ...initialActionableReviewState(), snapshot: validSnapshot(), selectedSuggestionId: 'sug-1' },
  })
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  assert.equal(ok, false)
  assert.equal(harness.transport.calls.length, 0)
})

test('decide is refused when the snapshot is stale', async () => {
  const snapshot = validSnapshot()
  snapshot.versions = { ...snapshot.versions, catalogFingerprint: 'sha256:drifted' }
  const harness = createHarness({
    initialState: { ...initialActionableReviewState(), snapshot, selectedSuggestionId: 'sug-1' },
  })
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  assert.equal(ok, false)
  assert.equal(harness.transport.calls.length, 0)
  assert.ok(harness.state().error)
})

test('decide is refused for a non-pending suggestion', async () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.status = 'added_pending_catalog'
  const harness = createHarness({
    initialState: { ...initialActionableReviewState(), snapshot, selectedSuggestionId: 'sug-1' },
  })
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  assert.equal(ok, false)
  assert.equal(harness.transport.calls.length, 0)
})

test('failed decision preserves the selected suggestion and audit drawer state', async () => {
  const before = {
    ...initialActionableReviewState(),
    snapshot: validSnapshot(),
    selectedSuggestionId: 'sug-1',
    auditOpen: true,
  }
  const harness = createHarness({ initialState: before })
  harness.transport.setResponse(async () => ({
    status: 409,
    json: async () => ({ error: 'stale fingerprint' }),
  }))
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  assert.equal(ok, false)
  // Form/selection/audit state must survive the failed decision.
  assert.equal(harness.state().selectedSuggestionId, 'sug-1')
  assert.equal(harness.state().auditOpen, true)
  assert.equal(harness.state().submittingSuggestionId, null)
  assert.ok(harness.state().error)
  assert.equal(harness.state().snapshot, before.snapshot)
})

test('decide surfaces a 401 through onUnauthorized', async () => {
  const harness = createHarness({
    initialState: { ...initialActionableReviewState(), snapshot: validSnapshot(), selectedSuggestionId: 'sug-1' },
  })
  harness.transport.setResponse(async () => ({
    status: 401,
    json: async () => ({ error: 'unauthorized' }),
  }))
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  assert.equal(ok, false)
  assert.equal(harness.unauthorized(), 1)
})

test('restore posts an opaque restore action', async () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.status = 'dismissed'
  const harness = createHarness({
    initialState: { ...initialActionableReviewState(), snapshot, selectedSuggestionId: 'sug-1' },
  })
  harness.transport.setResponse(async () => ({
    status: 200,
    json: async () => ({ ok: true }),
  }))
  const ok = await harness.client.restore('boq-1', 'run-1', 'sug-1')
  assert.equal(ok, true)
  assert.equal(harness.transport.calls[0]!.method, 'POST')
  assert.deepEqual(harness.transport.calls[0]!.body, {
    action: 'restore',
    expectedFingerprint: FINGERPRINT,
  })
})

test('restore is refused in read-only context', async () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.status = 'dismissed'
  const harness = createHarness({
    readOnly: true,
    initialState: { ...initialActionableReviewState(), snapshot, selectedSuggestionId: 'sug-1' },
  })
  const ok = await harness.client.restore('boq-1', 'run-1', 'sug-1')
  assert.equal(ok, false)
  assert.equal(harness.transport.calls.length, 0)
})

test('cancel aborts in-flight snapshot requests and clears loading state', async () => {
  const harness = createHarness()
  let abortedSignal: AbortSignal | undefined
  let resolveResponse!: (response: ActionableReviewTransportResponse) => void
  const response = new Promise<ActionableReviewTransportResponse>((resolve) => {
    resolveResponse = resolve
  })
  harness.transport.setResponse(async (req) => {
    abortedSignal = req.signal
    return response
  })
  const loadPromise = harness.client.load('boq-1', 'run-1', FINGERPRINT)
  harness.client.cancel()
  resolveResponse({ status: 200, json: async () => ({ snapshot: validSnapshot() }) })
  await loadPromise
  assert.ok(abortedSignal, 'transport received an abort signal')
  assert.equal(abortedSignal?.aborted, true)
  assert.equal(harness.state().loading, false)
  assert.equal(harness.state().submittingSuggestionId, null)
})

test('cancel clears an in-flight decision without applying its stale result', async () => {
  const harness = createHarness({
    initialState: {
      ...initialActionableReviewState(),
      snapshot: validSnapshot(),
      selectedSuggestionId: 'sug-1',
    },
  })
  let resolveResponse!: (response: ActionableReviewTransportResponse) => void
  const response = new Promise<ActionableReviewTransportResponse>((resolve) => {
    resolveResponse = resolve
  })
  harness.transport.setResponse(async () => response)
  const decisionPromise = harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  await Promise.resolve()
  assert.equal(harness.state().submittingSuggestionId, 'sug-1')
  harness.client.cancel()
  resolveResponse({ status: 200, json: async () => ({ ok: true }) })
  assert.equal(await decisionPromise, false)
  assert.equal(harness.state().submittingSuggestionId, null)
  assert.equal(harness.state().selectedSuggestionId, 'sug-1')
  assert.equal(harness.state().error, null)
})

test('client reuses the shared normalizer for empty audit-only snapshots', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions = []
  assert.ok(normalizeActionableReviewResponse(snapshot))
})


test('successful decide applies server snapshot and advances to the next pending suggestion', async () => {
  const secondId = 'sug-2'
  const initial = validSnapshot()
  initial.actionableItemSuggestions.push({
    ...initial.actionableItemSuggestions[0]!,
    id: secondId,
    sourceRowIds: ['row-2'],
  })
  const after = structuredClone(initial)
  after.actionableItemSuggestions[0]!.status = 'dismissed'
  after.validationSummary = {
    ...after.validationSummary,
    actionableCount: 1,
    dismissedCount: 1,
  }

  const harness = createHarness({
    initialState: {
      ...initialActionableReviewState(),
      snapshot: initial,
      selectedSuggestionId: 'sug-1',
    },
  })
  harness.transport.setResponse(async () => ({
    status: 200,
    json: async () => ({
      status: 'dismissed',
      snapshot: after,
    }),
  }))
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  assert.equal(ok, true)
  assert.equal(harness.state().submittingSuggestionId, null)
  assert.equal(harness.state().selectedSuggestionId, secondId)
  assert.equal(harness.state().snapshot?.actionableItemSuggestions[0]!.status, 'dismissed')
})

test('failed decide preserves selection, snapshot, and does not advance', async () => {
  const before = {
    ...initialActionableReviewState(),
    snapshot: validSnapshot(),
    selectedSuggestionId: 'sug-1',
  }
  const harness = createHarness({ initialState: before })
  harness.transport.setResponse(async () => ({
    status: 409,
    json: async () => ({ error: 'stale' }),
  }))
  const ok = await harness.client.decide('boq-1', 'run-1', 'sug-1', {
    action: 'dismiss',
    expectedFingerprint: FINGERPRINT,
  })
  assert.equal(ok, false)
  assert.equal(harness.state().selectedSuggestionId, 'sug-1')
  assert.equal(harness.state().snapshot, before.snapshot)
  assert.ok(harness.state().error)
})

test('nextPendingSuggestionId walks forward then wraps to the first pending', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions = [
    {
      ...snapshot.actionableItemSuggestions[0]!,
      id: 'a',
      status: 'dismissed',
    },
    {
      ...snapshot.actionableItemSuggestions[0]!,
      id: 'b',
      status: 'pending',
      sourceRowIds: ['row-b'],
    },
    {
      ...snapshot.actionableItemSuggestions[0]!,
      id: 'c',
      status: 'pending',
      sourceRowIds: ['row-c'],
    },
  ]
  assert.equal(nextPendingSuggestionId(snapshot, 'a'), 'b')
  assert.equal(nextPendingSuggestionId(snapshot, 'b'), 'c')
  assert.equal(nextPendingSuggestionId(snapshot, 'c'), 'b')
  snapshot.actionableItemSuggestions.forEach((s) => {
    s.status = 'dismissed'
  })
  assert.equal(nextPendingSuggestionId(snapshot, 'a'), null)
})
