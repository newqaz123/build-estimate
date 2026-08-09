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

function memoryDocuments() {
  const docs = new Map<string, Record<string, unknown>>()
  const writes: string[] = []
  const store: ActionableReviewDocumentStore = {
    async get(path: string) {
      const data = docs.get(path)
      return data ? { path, data: structuredClone(data) } : null
    },
    async setIfAbsent(path: string, data: Record<string, unknown>) {
      writes.push(path)
      if (docs.has(path)) return 'exists'
      docs.set(path, structuredClone(data))
      return 'created'
    },
    async set(path: string, data: Record<string, unknown>) {
      writes.push(path)
      docs.set(path, structuredClone(data))
    },
  }
  return { store, docs, writes }
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

test('idempotent snapshot writes create once and leave existing document untouched', async () => {
  const { store, docs, writes } = memoryDocuments()
  const storage = createActionableReviewStorage(store)
  const fingerprint = 'sha256:' + 'c'.repeat(64)
  const review = sampleReview(fingerprint)

  const first = await storage.writeSnapshot('boq-1', 'run-1', review)
  assert.equal(first, 'created')
  const original = structuredClone(docs.get(actionableReviewSnapshotPath('boq-1', 'run-1', fingerprint)))

  const second = await storage.writeSnapshot('boq-1', 'run-1', {
    ...review,
    generatedAt: '2026-08-09T00:00:00.000Z',
  })
  assert.equal(second, 'exists')
  assert.deepEqual(
    docs.get(actionableReviewSnapshotPath('boq-1', 'run-1', fingerprint)),
    original,
  )
  assert.ok(writes.length >= 2)
})

test('metrics writes are idempotent by fingerprint', async () => {
  const { store, docs } = memoryDocuments()
  const storage = createActionableReviewStorage(store)
  const fingerprint = 'sha256:' + 'd'.repeat(64)
  const metrics = sampleMetrics(fingerprint)

  assert.equal(await storage.writeMetrics('boq-1', 'run-1', metrics), 'created')
  assert.equal(
    await storage.writeMetrics('boq-1', 'run-1', {
      ...metrics,
      cost: { estimatedCostMinor: 99 },
    }),
    'exists',
  )
  const stored = docs.get(actionableReviewMetricsPath('boq-1', 'run-1', fingerprint))
  assert.equal((stored as { cost: { estimatedCostMinor: number } }).cost.estimatedCostMinor, 0)
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
})

test('getters return null for missing documents and parse stored payloads', async () => {
  const { store } = memoryDocuments()
  const storage = createActionableReviewStorage(store)
  const fingerprint = 'sha256:' + 'e'.repeat(64)
  assert.equal(await storage.getSnapshot('boq-1', 'run-1', fingerprint), null)
  assert.equal(await storage.getMetrics('boq-1', 'run-1', fingerprint), null)

  const review = sampleReview(fingerprint)
  const metrics = sampleMetrics(fingerprint)
  await storage.writeSnapshot('boq-1', 'run-1', review)
  await storage.writeMetrics('boq-1', 'run-1', metrics)

  assert.deepEqual(await storage.getSnapshot('boq-1', 'run-1', fingerprint), review)
  assert.deepEqual(await storage.getMetrics('boq-1', 'run-1', fingerprint), metrics)
})
