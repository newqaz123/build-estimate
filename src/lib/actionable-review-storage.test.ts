import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActionableReview } from './actionable-review-projection'
import type { ActionableReviewMetrics } from './actionable-review-metrics'
import {
  actionableReviewMetricsPath,
  actionableReviewSnapshotPath,
  createActionableReviewStorage,
  parseActionableReviewMetricsDocument,
  parseActionableReviewSnapshotDocument,
  type ActionableReviewDocumentStore,
} from './actionable-review-storage'

function memoryDocuments(options: { failNextBundle?: boolean } = {}) {
  const docs = new Map<string, Record<string, unknown>>()
  const writes: string[] = []
  let failNextBundle = options.failNextBundle === true
  const store: ActionableReviewDocumentStore & {
    docs: Map<string, Record<string, unknown>>
    writes: string[]
    setFailNext(value: boolean): void
  } = {
    docs,
    writes,
    setFailNext(value: boolean) {
      failNextBundle = value
    },
    async get(path: string) {
      const data = docs.get(path)
      return data ? { path, data: structuredClone(data) } : null
    },
    async setBundleIfAbsent(input) {
      if (failNextBundle) {
        failNextBundle = false
        throw new Error('injected bundle failure')
      }
      const hasSnap = docs.has(input.snapshotPath)
      const hasMetrics = docs.has(input.metricsPath)
      if (hasSnap || hasMetrics) {
        if (!hasSnap || !hasMetrics) {
          throw new Error('Incomplete actionable review bundle.')
        }
        return {
          status: 'exists' as const,
          snapshotData: structuredClone(docs.get(input.snapshotPath)!),
          metricsData: structuredClone(docs.get(input.metricsPath)!),
        }
      }
      writes.push(input.snapshotPath, input.metricsPath)
      docs.set(input.snapshotPath, structuredClone(input.snapshotData))
      docs.set(input.metricsPath, structuredClone(input.metricsData))
      return { status: 'created' as const }
    },
  }
  return store
}

function sampleReview(fingerprint = 'sha256:' + 'a'.repeat(64)): ActionableReview {
  return {
    id: fingerprint,
    extractionRunId: 'run-1',
    actionableItemSuggestions: [],
    dismissedEvidence: [],
    representedRows: [],
    validationSummary: {
      rawRowCount: 2,
      actionableCount: 0,
      dismissedCount: 1,
      representedCount: 1,
      locallyPreparedCatalogCount: 0,
      aiReviewedCount: 0,
      sourceTotalDifference: '0',
      rejectedReasonCounts: {},
    },
    versions: {
      extractionFingerprint: 'sha256:extract',
      boqSectionsFingerprint: 'sha256:boq',
      catalogFingerprint: 'sha256:catalog',
      conversionFingerprint: 'sha256:conversion',
      promptVersion: 'actionable-review-ai-v1',
      modelVersion: 'gpt-4o-mini',
    },
    generatedAt: '2026-08-08T12:00:00.000Z',
    mode: 'shadow',
  }
}

function sampleMetrics(fingerprint = 'sha256:' + 'a'.repeat(64)): ActionableReviewMetrics {
  return {
    fingerprint,
    extractionRunId: 'run-1',
    generatedAt: '2026-08-08T12:00:00.000Z',
    mode: 'shadow',
    counts: {
      rawRowCount: 2,
      actionableCount: 0,
      dismissedCount: 1,
      representedCount: 1,
      locallyPreparedCatalogCount: 0,
      aiReviewedCount: 0,
      cacheHitCount: 0,
      initialCallCount: 0,
      escalationCallCount: 0,
    },
    cost: {
      estimatedCostMinor: 0,
    },
    quality: {
      rejectedReasonCounts: {},
      decisionCounts: {
        match: 0,
        create: 0,
        dismiss: 0,
        uncertain: 0,
      },
      sourceTotalDifference: '0',
      providerUnavailable: false,
    },
  }
}

function nestedSuggestionReview(fingerprint: string): ActionableReview {
  return {
    ...sampleReview(fingerprint),
    actionableItemSuggestions: [
      {
        id: 'sha256:' + 'b'.repeat(64),
        extractionRunId: 'run-1',
        sourceRowIds: ['row-1'],
        sourceRefs: [{ page: 1, table: 0, row: 1 }],
        sourceCellMapping: {
          sourceRowIds: ['row-1'],
          description: [{ sourceRowId: 'row-1', column: 0 }],
          unit: { sourceRowId: 'row-1', column: 1 },
          quantity: { sourceRowId: 'row-1', column: 2 },
          rate: { sourceRowId: 'row-1', column: 3 },
          total: { sourceRowId: 'row-1', column: 4 },
        },
        rowRole: 'priced_item',
        deterministicReasons: ['clear_priced_item'],
        suggestedSectionIndex: 0,
        extractedItem: {
          description: 'Ready mix',
          unit: 'm3',
          quantity: '10',
          materialRate: '100',
          labourRate: '0',
          total: '1000',
        },
        catalogCandidates: [
          {
            catalogId: 'std-1',
            description: 'Ready mix',
            unit: 'm3',
            matchKind: 'exact',
            score: 100,
          },
        ],
        aiAdvice: {
          sourceRowId: 'row-1',
          decision: 'match',
          catalogId: 'std-1',
          confidence: 0.9,
          reason: 'exact',
        },
        status: 'pending',
        versions: sampleReview(fingerprint).versions,
      },
    ],
    dismissedEvidence: [
      {
        sourceRowId: 'row-h',
        role: 'column_header',
        reasonCodes: ['header_band'],
        deterministic: true,
        sourceRef: { page: 1, table: 0, row: 0 },
      },
    ],
    representedRows: [
      {
        sourceRowIds: ['row-2'],
        boqItemId: 'item-2',
        reason: 'accepted_audit',
        sourceRefs: [{ page: 1, table: 0, row: 2 }],
      },
    ],
  }
}

test('snapshot and metrics paths nest under extraction run fingerprints', () => {
  const fingerprint = 'sha256:' + 'b'.repeat(64)
  assert.equal(
    actionableReviewSnapshotPath('boq-1', 'run-1', fingerprint),
    `boqs/boq-1/extractionRuns/run-1/actionableReviewSnapshots/${fingerprint}`,
  )
  assert.equal(
    actionableReviewMetricsPath('boq-1', 'run-1', fingerprint),
    `boqs/boq-1/extractionRuns/run-1/actionableReviewMetrics/${fingerprint}`,
  )
})

test('atomic bundle write creates both docs and is content-stable on collision', async () => {
  const documents = memoryDocuments()
  const storage = createActionableReviewStorage(documents)
  const fingerprint = 'sha256:' + 'c'.repeat(64)
  const review = sampleReview(fingerprint)
  const metrics = sampleMetrics(fingerprint)

  const first = await storage.writeBundle('boq-1', 'run-1', review, metrics)
  assert.equal(first.status, 'created')
  assert.equal(documents.docs.size, 2)

  const second = await storage.writeBundle(
    'boq-1',
    'run-1',
    { ...review, generatedAt: '2099-01-01T00:00:00.000Z' },
    { ...metrics, cost: { estimatedCostMinor: 99 } },
  )
  assert.equal(second.status, 'exists')
  assert.equal(second.snapshot.generatedAt, '2026-08-08T12:00:00.000Z')
  assert.equal(second.metrics.cost.estimatedCostMinor, 0)
  assert.deepEqual(second.snapshot, first.snapshot)
  assert.deepEqual(second.metrics, first.metrics)
})

test('injected bundle failure leaves neither snapshot nor metrics; retry recovers', async () => {
  const documents = memoryDocuments({ failNextBundle: true })
  const storage = createActionableReviewStorage(documents)
  const fingerprint = 'sha256:' + 'd'.repeat(64)
  const review = sampleReview(fingerprint)
  const metrics = sampleMetrics(fingerprint)

  await assert.rejects(
    () => storage.writeBundle('boq-1', 'run-1', review, metrics),
    /injected bundle failure/,
  )
  assert.equal(documents.docs.size, 0)
  assert.equal(await storage.getSnapshot('boq-1', 'run-1', fingerprint), null)
  assert.equal(await storage.getMetrics('boq-1', 'run-1', fingerprint), null)

  const recovered = await storage.writeBundle('boq-1', 'run-1', review, metrics)
  assert.equal(recovered.status, 'created')
  assert.equal(documents.docs.size, 2)
  assert.ok(await storage.getSnapshot('boq-1', 'run-1', fingerprint))
  assert.ok(await storage.getMetrics('boq-1', 'run-1', fingerprint))
})

test('fail-closed parsers reject raw content fields and unknown keys', () => {
  assert.throws(
    () => parseActionableReviewMetricsDocument({
      ...sampleMetrics(),
      rawText: 'secret pdf text',
    }),
    /unexpected key|Invalid|raw content/,
  )
  assert.throws(
    () => parseActionableReviewMetricsDocument({
      ...sampleMetrics(),
      quality: {
        ...sampleMetrics().quality,
        providerReason: 'model said concrete',
      },
    }),
    /unexpected key|Invalid|raw content/,
  )
  assert.throws(
    () => parseActionableReviewSnapshotDocument({
      ...sampleReview(),
      extra: true,
    }),
    /unexpected key|Invalid|raw content/,
  )
  assert.throws(
    () => parseActionableReviewMetricsDocument({
      ...sampleMetrics(),
      quality: {
        ...sampleMetrics().quality,
        sourceTotalDifference: '12.50e1',
      },
    }),
    /sourceTotalDifference|Invalid|decimal/,
  )
})

test('deep snapshot parser rejects corrupt nested money/status/role/candidate/advice', () => {
  const fingerprint = 'sha256:' + 'e'.repeat(64)
  const good = nestedSuggestionReview(fingerprint)
  assert.doesNotThrow(() => parseActionableReviewSnapshotDocument(good))

  const badMoney = structuredClone(good) as ActionableReview
  badMoney.actionableItemSuggestions[0]!.extractedItem.total = '1e3' as never
  assert.throws(() => parseActionableReviewSnapshotDocument(badMoney), /extractedItem|Invalid/)

  const badStatus = structuredClone(good) as ActionableReview
  ;(badStatus.actionableItemSuggestions[0] as { status: string }).status = 'approved'
  assert.throws(() => parseActionableReviewSnapshotDocument(badStatus), /status|Invalid/)

  const badRole = structuredClone(good) as ActionableReview
  ;(badRole.dismissedEvidence[0] as { role: string }).role = 'not_a_role'
  assert.throws(() => parseActionableReviewSnapshotDocument(badRole), /role|Invalid/)

  const badCandidate = structuredClone(good) as ActionableReview
  badCandidate.actionableItemSuggestions[0]!.catalogCandidates.push({
    catalogId: 'x',
    description: 'y',
    unit: 'm',
    matchKind: 'exact',
    score: 1,
    mystery: true,
  } as never)
  assert.throws(() => parseActionableReviewSnapshotDocument(badCandidate), /catalogCandidates|unexpected key|Invalid/)

  const badAdvice = structuredClone(good) as ActionableReview
  badAdvice.actionableItemSuggestions[0]!.aiAdvice = {
    sourceRowId: 'row-1',
    decision: 'match',
    confidence: 0.5,
    reason: 'x',
    // match without catalogId
  }
  assert.throws(() => parseActionableReviewSnapshotDocument(badAdvice), /aiAdvice|Invalid/)

  const badUnknownNested = structuredClone(good) as ActionableReview
  ;(badUnknownNested.actionableItemSuggestions[0] as unknown as Record<string, unknown>).rate = '9'
  assert.throws(() => parseActionableReviewSnapshotDocument(badUnknownNested), /unexpected key|Invalid/)

  const badVersion = structuredClone(good) as ActionableReview
  ;(badVersion.versions as { promptVersion: string }).promptVersion = ''
  assert.throws(() => parseActionableReviewSnapshotDocument(badVersion), /versions|Invalid/)
})

test('getters return null for missing documents and parse stored payloads', async () => {
  const documents = memoryDocuments()
  const storage = createActionableReviewStorage(documents)
  const fingerprint = 'sha256:' + 'f'.repeat(64)
  assert.equal(await storage.getSnapshot('boq-1', 'run-1', fingerprint), null)
  assert.equal(await storage.getMetrics('boq-1', 'run-1', fingerprint), null)

  const review = nestedSuggestionReview(fingerprint)
  const metrics = sampleMetrics(fingerprint)
  await storage.writeBundle('boq-1', 'run-1', review, metrics)

  assert.deepEqual(await storage.getSnapshot('boq-1', 'run-1', fingerprint), review)
  assert.deepEqual(await storage.getMetrics('boq-1', 'run-1', fingerprint), metrics)
})
