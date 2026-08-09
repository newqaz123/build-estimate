import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTIONABLE_SUGGESTION_STATUSES,
  actionableReviewReducer,
  beginActionableReviewRequest,
  canMutateActionableReview,
  createActionableReviewRequestGeneration,
  initialActionableReviewState,
  invalidateActionableReviewRequests,
  isActionableReviewStale,
  isLatestActionableReviewRequest,
  isSuggestionMutable,
  normalizeActionableReviewResponse,
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

test('normalizeActionableReviewResponse accepts a closed valid snapshot', () => {
  const snapshot = validSnapshot()
  const normalized = normalizeActionableReviewResponse(snapshot)
  assert.equal(normalized?.id, FINGERPRINT)
  assert.equal(normalized?.actionableItemSuggestions.length, 1)
})

test('normalizeActionableReviewResponse rejects non-object payloads', () => {
  for (const value of [null, undefined, 'x', 1, true, [], 'shadow']) {
    assert.equal(normalizeActionableReviewResponse(value), null)
  }
})

test('normalizeActionableReviewResponse rejects malformed review id', () => {
  for (const id of ['', 'plain', 'sha256:short', 'sha256:XYZ', 'not-a-hash']) {
    const snapshot = validSnapshot()
    ;(snapshot as { id: string }).id = id
    assert.equal(
      normalizeActionableReviewResponse(snapshot),
      null,
      `expected null for id ${id}`,
    )
  }
})

test('normalizeActionableReviewResponse rejects unknown review mode', () => {
  const snapshot = validSnapshot()
  ;(snapshot as { mode: string }).mode = 'live'
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects duplicate suggestion ids', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions.push({
    ...snapshot.actionableItemSuggestions[0]!,
    sourceRowIds: ['row-2'],
    sourceRefs: [{ page: 1, table: 0, row: 2 }],
  })
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects duplicate source row ids across suggestions', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions.push({
    ...snapshot.actionableItemSuggestions[0]!,
    id: 'sug-2',
    // Reuses row-1 — a source row can only back one suggestion.
    sourceRowIds: ['row-1'],
    sourceRefs: [{ page: 1, table: 0, row: 1 }],
  })
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects duplicate source row ids within a suggestion', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.sourceRowIds = ['row-1', 'row-1']
  snapshot.actionableItemSuggestions[0]!.sourceRefs = [
    { page: 1, table: 0, row: 1 },
    { page: 1, table: 0, row: 1 },
  ]
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects missing provenance (empty sourceRowIds / missing sourceRefs)', () => {
  for (const tweak of [
    { sourceRowIds: [], sourceRefs: [] },
    { sourceRowIds: ['row-1'], sourceRefs: [] },
    { sourceRowIds: ['row-1'], sourceRefs: [{ page: 1, table: 0 }] },
  ]) {
    const snapshot = validSnapshot()
    snapshot.actionableItemSuggestions[0]!.sourceRowIds = tweak.sourceRowIds
    snapshot.actionableItemSuggestions[0]!.sourceRefs = tweak.sourceRefs as ActionableReview['actionableItemSuggestions'][number]['sourceRefs']
    assert.equal(
      normalizeActionableReviewResponse(snapshot),
      null,
      `expected null for ${JSON.stringify(tweak)}`,
    )
  }
})

test('normalizeActionableReviewResponse rejects provenance/sourceRef count mismatch', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.sourceRefs = [
    { page: 1, table: 0, row: 1 },
    { page: 1, table: 0, row: 2 },
  ]
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects unknown row role', () => {
  const snapshot = validSnapshot()
  ;(snapshot.actionableItemSuggestions[0] as { rowRole: string }).rowRole = 'item'
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects unknown suggestion status', () => {
  const snapshot = validSnapshot()
  ;(snapshot.actionableItemSuggestions[0] as { status: string }).status = 'queued'
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects malformed versions', () => {
  for (const override of [
    { extractionFingerprint: '' },
    { catalogFingerprint: '' },
    { promptVersion: '' },
    { unexpectedKey: 'x' },
    { conversionFingerprint: 1 },
  ]) {
    const snapshot = validSnapshot()
    snapshot.versions = { ...validVersions(), ...override } as unknown as typeof snapshot.versions
    assert.equal(
      normalizeActionableReviewResponse(snapshot),
      null,
      `expected null for versions ${JSON.stringify(override)}`,
    )
  }
})

test('normalizeActionableReviewResponse rejects suggestion versions that disagree with review versions', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.versions = {
    ...validVersions(),
    extractionFingerprint: 'sha256:different',
  }
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse enforces catalog allowlist on aiAdvice.catalogId', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.aiAdvice = {
    sourceRowId: 'row-1',
    decision: 'match',
    catalogId: 'std-missing',
    confidence: 0.9,
    reason: 'model_match',
  }
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse accepts aiAdvice.catalogId within the shortlist', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.aiAdvice = {
    sourceRowId: 'row-1',
    decision: 'match',
    catalogId: 'std-1',
    confidence: 0.9,
    reason: 'model_match',
  }
  assert.ok(normalizeActionableReviewResponse(snapshot))
})

test('normalizeActionableReviewResponse enforces catalog allowlist on normalization.catalogId', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.normalization = {
    catalogId: 'std-missing',
    catalogDescription: 'Concrete',
    catalogUnit: 'm3',
    ruleId: 'rule-1',
    catalogUnitsPerSourceUnit: '1',
    normalizedQuantity: '2',
    normalizedMaterialRate: '50',
    normalizedLabourRate: '0',
    normalizedTotal: '100',
  }
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse accepts normalization.catalogId within the shortlist', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.normalization = {
    catalogId: 'std-1',
    catalogDescription: 'Concrete',
    catalogUnit: 'm3',
    ruleId: 'rule-1',
    catalogUnitsPerSourceUnit: '1',
    normalizedQuantity: '2',
    normalizedMaterialRate: '50',
    normalizedLabourRate: '0',
    normalizedTotal: '100',
  }
  assert.ok(normalizeActionableReviewResponse(snapshot))
})

test('normalizeActionableReviewResponse rejects extra numeric AI fields on advice', () => {
  for (const extra of [
    { rate: '10' },
    { total: 5 },
    { conversionFactor: '2' },
    { quantity: '2' },
    { normalizedTotal: '100' },
    { approvedBy: 'model' },
  ]) {
    const snapshot = validSnapshot()
    snapshot.actionableItemSuggestions[0]!.aiAdvice = {
      sourceRowId: 'row-1',
      decision: 'uncertain',
      confidence: 0.5,
      reason: 'low_confidence',
      ...extra,
    } as never
    assert.equal(
      normalizeActionableReviewResponse(snapshot),
      null,
      `expected null for extra advice field ${JSON.stringify(extra)}`,
    )
  }
})

test('normalizeActionableReviewResponse rejects extra authoritative fields on a suggestion', () => {
  for (const extra of [
    { normalizedTotal: '100' },
    { conversionFactor: '2' },
    { reviewerPricing: { total: '100' } },
    { approvedBy: 'user' },
    { extractedPricing: { total: '100' } },
  ]) {
    const snapshot = validSnapshot()
    Object.assign(snapshot.actionableItemSuggestions[0]!, extra)
    assert.equal(
      normalizeActionableReviewResponse(snapshot),
      null,
      `expected null for extra suggestion field ${JSON.stringify(extra)}`,
    )
  }
})

test('normalizeActionableReviewResponse rejects extra keys on the review object', () => {
  const snapshot = validSnapshot()
  ;(snapshot as unknown as Record<string, unknown>).aiBatch = { estimatedCostMinor: 5 }
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects malformed catalog candidates', () => {
  for (const override of [
    { catalogId: '' },
    { matchKind: 'best' },
    { score: 'high' },
    { unit: 1 },
    { unexpected: true },
  ]) {
    const snapshot = validSnapshot()
    snapshot.actionableItemSuggestions[0]!.catalogCandidates = [
      {
        catalogId: 'std-1',
        description: 'Concrete C25',
        unit: 'm3',
        matchKind: 'exact',
        score: 100,
        ...override,
      },
    ] as unknown as typeof snapshot.actionableItemSuggestions[number]['catalogCandidates']
    assert.equal(
      normalizeActionableReviewResponse(snapshot),
      null,
      `expected null for candidate ${JSON.stringify(override)}`,
    )
  }
})

test('normalizeActionableReviewResponse rejects malformed extracted pricing', () => {
  const snapshot = validSnapshot()
  ;(snapshot.actionableItemSuggestions[0]!.extractedItem as unknown as Record<string, unknown>).quantity = 'not-a-number'
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects malformed validation summary', () => {
  for (const override of [
    { rawRowCount: '1' },
    { actionableCount: -1 },
    { sourceTotalDifference: 0 },
    { rejectedReasonCounts: [] },
    { unknownSummaryKey: true },
  ]) {
    const snapshot = validSnapshot()
    snapshot.validationSummary = {
      ...snapshot.validationSummary,
      ...override,
    } as never
    assert.equal(
      normalizeActionableReviewResponse(snapshot),
      null,
      `expected null for summary ${JSON.stringify(override)}`,
    )
  }
})

test('normalizeActionableReviewResponse accepts a dismissed (stale) suggestion without mutating its status', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.status = 'dismissed'
  const normalized = normalizeActionableReviewResponse(snapshot)
  assert.equal(normalized?.actionableItemSuggestions[0]?.status, 'dismissed')
})

test('normalizeActionableReviewResponse preserves dismissedEvidence and representedRows shape', () => {
  const snapshot = validSnapshot()
  snapshot.dismissedEvidence = [
    {
      sourceRowId: 'row-9',
      role: 'note',
      reasonCodes: ['note_row'],
      deterministic: true,
      sourceRef: { page: 1, table: 0, row: 9 },
    },
  ]
  snapshot.representedRows = [
    {
      sourceRowIds: ['row-8'],
      boqItemId: 'item-8',
      reason: 'source_identity',
      sourceRefs: [{ page: 1, table: 0, row: 8 }],
    },
  ]
  const normalized = normalizeActionableReviewResponse(snapshot)
  assert.equal(normalized?.dismissedEvidence.length, 1)
  assert.equal(normalized?.representedRows.length, 1)
})

test('normalizeActionableReviewResponse rejects malformed dismissed evidence', () => {
  const snapshot = validSnapshot()
  snapshot.dismissedEvidence = [
    {
      sourceRowId: 'row-9',
      role: 'not-a-role',
      reasonCodes: ['note_row'],
      deterministic: true,
      sourceRef: { page: 1, table: 0, row: 9 },
    },
  ] as unknown as typeof snapshot.dismissedEvidence
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

test('normalizeActionableReviewResponse rejects malformed represented rows', () => {
  const snapshot = validSnapshot()
  snapshot.representedRows = [
    {
      sourceRowIds: [],
      boqItemId: 'item-8',
      reason: 'source_identity',
      sourceRefs: [],
    },
  ]
  assert.equal(normalizeActionableReviewResponse(snapshot), null)
})

// ---- Status domain ----

test('ACTIONABLE_SUGGESTION_STATUSES enumerates the closed status domain', () => {
  assert.deepEqual(
    [...ACTIONABLE_SUGGESTION_STATUSES].sort(),
    [
      'added_matched',
      'added_pending_catalog',
      'dismissed',
      'pending',
      'stale',
    ],
  )
})

// ---- Reducer ----

test('initialActionableReviewState starts empty and idle', () => {
  assert.deepEqual(initialActionableReviewState(), {
    snapshot: null,
    selectedSuggestionId: null,
    auditOpen: false,
    loading: false,
    submittingSuggestionId: null,
    error: null,
  })
})

test('load_started transitions to loading and clears error', () => {
  const state = actionableReviewReducer(initialActionableReviewState(), {
    type: 'load_started',
  })
  assert.equal(state.loading, true)
  assert.equal(state.error, null)
})

test('load_succeeded stores the snapshot and clears loading', () => {
  const snapshot = validSnapshot()
  const state = actionableReviewReducer(
    { ...initialActionableReviewState(), loading: true, error: 'boom' },
    { type: 'load_succeeded', snapshot },
  )
  assert.equal(state.loading, false)
  assert.equal(state.error, null)
  assert.equal(state.snapshot, snapshot)
})

test('load_succeeded keeps a still-valid selectedSuggestionId', () => {
  const snapshot = validSnapshot()
  const state = actionableReviewReducer(
    { ...initialActionableReviewState(), selectedSuggestionId: 'sug-1' },
    { type: 'load_succeeded', snapshot },
  )
  assert.equal(state.selectedSuggestionId, 'sug-1')
})

test('load_succeeded clears a selectedSuggestionId that is no longer present', () => {
  const snapshot = validSnapshot()
  const state = actionableReviewReducer(
    { ...initialActionableReviewState(), selectedSuggestionId: 'gone' },
    { type: 'load_succeeded', snapshot },
  )
  assert.equal(state.selectedSuggestionId, null)
})

test('load_failed clears loading and records the error', () => {
  const state = actionableReviewReducer(
    { ...initialActionableReviewState(), loading: true },
    { type: 'load_failed', error: 'network down' },
  )
  assert.equal(state.loading, false)
  assert.equal(state.error, 'network down')
})

test('decision_started records the submitting suggestion and clears error', () => {
  const state = actionableReviewReducer(initialActionableReviewState(), {
    type: 'decision_started',
    suggestionId: 'sug-1',
  })
  assert.equal(state.submittingSuggestionId, 'sug-1')
  assert.equal(state.error, null)
})

test('decision_failed preserves selected suggestion and form state', () => {
  const before = {
    ...initialActionableReviewState(),
    snapshot: validSnapshot(),
    selectedSuggestionId: 'sug-1',
    submittingSuggestionId: 'sug-1',
    auditOpen: true,
  }
  const state = actionableReviewReducer(before, {
    type: 'decision_failed',
    suggestionId: 'sug-1',
    error: 'conflict',
  })
  assert.equal(state.submittingSuggestionId, null)
  assert.equal(state.error, 'conflict')
  // Form/selection state must survive a failed decision.
  assert.equal(state.selectedSuggestionId, 'sug-1')
  assert.equal(state.auditOpen, true)
  assert.equal(state.snapshot, before.snapshot)
})

test('decision_succeeded clears submitting state and error', () => {
  const before = {
    ...initialActionableReviewState(),
    submittingSuggestionId: 'sug-1',
    error: 'earlier',
  }
  const state = actionableReviewReducer(before, {
    type: 'decision_succeeded',
    suggestionId: 'sug-1',
  })
  assert.equal(state.submittingSuggestionId, null)
  assert.equal(state.error, null)
})

test('select_suggestion sets the selected suggestion id', () => {
  const state = actionableReviewReducer(initialActionableReviewState(), {
    type: 'select_suggestion',
    suggestionId: 'sug-2',
  })
  assert.equal(state.selectedSuggestionId, 'sug-2')
})

test('toggle_audit flips the audit drawer', () => {
  const opened = actionableReviewReducer(initialActionableReviewState(), {
    type: 'toggle_audit',
  })
  assert.equal(opened.auditOpen, true)
  const closed = actionableReviewReducer(opened, { type: 'toggle_audit' })
  assert.equal(closed.auditOpen, false)
})

test('clear_error clears only the error field', () => {
  const before = { ...initialActionableReviewState(), error: 'x', auditOpen: true }
  const state = actionableReviewReducer(before, { type: 'clear_error' })
  assert.equal(state.error, null)
  assert.equal(state.auditOpen, true)
})

// ---- Request generation guard (latest-request-wins) ----

test('beginActionableReviewRequest increments the generation counter', () => {
  const gen = createActionableReviewRequestGeneration()
  assert.equal(gen.current, 0)
  const first = beginActionableReviewRequest(gen)
  assert.equal(first, 1)
  const second = beginActionableReviewRequest(gen)
  assert.equal(second, 2)
})

test('isLatestActionableReviewRequest only honours the newest request', () => {
  const gen = createActionableReviewRequestGeneration()
  const a = beginActionableReviewRequest(gen)
  const b = beginActionableReviewRequest(gen)
  assert.equal(isLatestActionableReviewRequest(gen, a), false)
  assert.equal(isLatestActionableReviewRequest(gen, b), true)
})

test('invalidateActionableReviewRequests supersedes in-flight requests', () => {
  const gen = createActionableReviewRequestGeneration()
  const a = beginActionableReviewRequest(gen)
  assert.equal(isLatestActionableReviewRequest(gen, a), true)
  invalidateActionableReviewRequests(gen)
  assert.equal(isLatestActionableReviewRequest(gen, a), false)
})

// ---- Stale snapshot mutation gating ----

const expectedScope: ActionableReviewVersionScope = {
  extractionFingerprint: 'sha256:e',
  boqSectionsFingerprint: 'sha256:b',
  catalogFingerprint: 'sha256:c',
  conversionFingerprint: 'sha256:v',
}

test('isActionableReviewStale is false when versions match the expected scope', () => {
  const snapshot = validSnapshot()
  assert.equal(isActionableReviewStale(snapshot, expectedScope), false)
})

test('isActionableReviewStale is true when any version drifts', () => {
  for (const drift of [
    'extractionFingerprint',
    'boqSectionsFingerprint',
    'catalogFingerprint',
    'conversionFingerprint',
  ] as const) {
    const snapshot = validSnapshot()
    snapshot.versions = { ...snapshot.versions, [drift]: 'sha256:drifted' }
    assert.equal(
      isActionableReviewStale(snapshot, expectedScope),
      true,
      `expected stale for ${drift} drift`,
    )
  }
})

test('isActionableReviewStale is true when there is no expected scope', () => {
  const snapshot = validSnapshot()
  assert.equal(isActionableReviewStale(snapshot, null), true)
})

test('canMutateActionableReview is false for read-only context even when fresh', () => {
  const snapshot = validSnapshot()
  assert.equal(canMutateActionableReview(snapshot, expectedScope, true), false)
})

test('canMutateActionableReview is false when the snapshot is stale', () => {
  const snapshot = validSnapshot()
  snapshot.versions = { ...snapshot.versions, catalogFingerprint: 'sha256:drifted' }
  assert.equal(canMutateActionableReview(snapshot, expectedScope, false), false)
})

test('canMutateActionableReview is true only when fresh and writable', () => {
  const snapshot = validSnapshot()
  assert.equal(canMutateActionableReview(snapshot, expectedScope, false), true)
})

test('canMutateActionableReview is false without a snapshot', () => {
  assert.equal(canMutateActionableReview(null, expectedScope, false), false)
})

test('isSuggestionMutable is false for a non-pending suggestion', () => {
  const snapshot = validSnapshot()
  snapshot.actionableItemSuggestions[0]!.status = 'added_pending_catalog'
  assert.equal(
    isSuggestionMutable(snapshot, 'sug-1', expectedScope, false),
    false,
  )
})

test('isSuggestionMutable is false for an unknown suggestion id', () => {
  const snapshot = validSnapshot()
  assert.equal(
    isSuggestionMutable(snapshot, 'missing', expectedScope, false),
    false,
  )
})

test('isSuggestionMutable stays false when the snapshot is stale even if pending', () => {
  const snapshot = validSnapshot()
  snapshot.versions = { ...snapshot.versions, extractionFingerprint: 'sha256:drifted' }
  assert.equal(
    isSuggestionMutable(snapshot, 'sug-1', expectedScope, false),
    false,
  )
})

test('isSuggestionMutable is true for a fresh pending suggestion', () => {
  const snapshot = validSnapshot()
  assert.equal(isSuggestionMutable(snapshot, 'sug-1', expectedScope, false), true)
})
