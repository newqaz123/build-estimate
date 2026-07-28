import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreflightUpload } from '@/lib/boq-preflight-schema'
import type { PreflightCreateInput } from '@/lib/boq-preflight-storage'
import { createPreflightService } from '@/lib/boq-preflight-service'

type PreflightUpdatePatch = Partial<PreflightUpload> & { preserveForRetry?: boolean }

function mockPreflightUpload(overrides: Partial<PreflightUpload> = {}): PreflightUpload {
  return {
    id: 'preflight-1',
    fileName: 'test.pdf',
    pageCount: 2,
    status: 'ready',
    pages: [
      { page: 1, suggested: true, confidence: 0.85, reasons: ['thai_boq_terms'], textSource: 'embedded' },
      { page: 2, suggested: false, confidence: 0.3, reasons: [], textSource: 'embedded' },
    ],
    confirmedPages: null,
    ...overrides,
  }
}

function mockPreflightRecord(overrides: Partial<PreflightUpload> = {}) {
  return {
    ...mockPreflightUpload(overrides),
    ownerId: 'user-1',
    sourceDigest: 'sha256:abc123',
    sourceName: 'test.pdf',
    sourceType: 'application/pdf',
    sourceSize: 1234,
    expiresAt: '2026-07-27T12:00:00.000Z',
    createdAt: '2026-07-27T11:00:00.000Z',
    updatedAt: '2026-07-27T11:00:00.000Z',
  }
}

test('createPreflight validates file via requireSinglePdf', async () => {
  let validated = false
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord({ status: 'uploaded' }),
      getOwned: async () => null,
      update: async (_id, _ownerId, patch) => mockPreflightRecord({ ...patch, status: 'ready' }),
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [
        { page: 1, embeddedText: 'text', geometry: { tableCount: 0, numericTokenCount: 0 } },
        { page: 2, embeddedText: 'text', geometry: { tableCount: 0, numericTokenCount: 0 } },
      ],
    },
    requireSinglePdf: (file) => {
      validated = true
      if (!(file instanceof File)) throw new TypeError('Not a File')
      return file
    },
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  const file = new File([Buffer.from('%PDF')], 'test.pdf', { type: 'application/pdf' })
  await service.createPreflight(file, 'user-1')

  assert.equal(validated, true)
})

test('createPreflight throws on invalid file', async () => {
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord({ status: 'uploaded' }),
      getOwned: async () => null,
      update: async () => null,
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: () => {
      throw new TypeError('Invalid PDF')
    },
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  const file = new File([], 'test.txt', { type: 'text/plain' })
  await assert.rejects(async () => await service.createPreflight(file, 'user-1'), {
    message: 'Invalid PDF',
  })
})

test('createPreflight stores source, runs analysis, and persists ready record', async () => {
  let createCalled = false
  let updateCalled = false
  let storageSaveCalled = false
  let analysisCalled = false

  const store = {
    create: async (input: PreflightCreateInput) => {
      createCalled = true
      assert.equal(input.ownerId, 'user-1')
      assert.equal(input.fileName, 'test.pdf')
      assert.equal(input.status, 'uploaded')
      return mockPreflightRecord({ status: 'uploaded', id: input.id })
    },
    getOwned: async () => null,
    update: async (_id: string, _ownerId: string, patch: PreflightUpdatePatch) => {
      updateCalled = true
      assert.equal(patch.status, 'ready')
      assert.ok(Array.isArray(patch.pages))
      assert.equal(patch.pages.length, 2)
      assert.equal(patch.pages[0]?.page, 1)
      assert.equal(patch.pages[0]?.suggested, true)
      return mockPreflightRecord({ ...patch, status: 'ready' })
    },
    deleteArtifacts: async () => false,
    claimExpired: async () => [],
  }

  const storageAdapter = {
    saveSource: async (file: File, ownerId: string, id: string) => {
      storageSaveCalled = true
      assert.ok(file instanceof File)
      return `preflight/${ownerId}/${id}/source.pdf`
    },
    loadSource: async () => new File([], 'source.pdf', { type: 'application/pdf' }),
  }

  const analysisAdapter = {
    analyzePdf: async (file: File) => {
      analysisCalled = true
      assert.ok(file instanceof File)
      return [
        {
          page: 1,
          embeddedText: 'รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม',
          geometry: { tableCount: 2, numericTokenCount: 10 },
        },
        {
          page: 2,
          embeddedText: 'Description Quantity Material',
          geometry: { tableCount: 1, numericTokenCount: 5 },
        },
      ]
    },
  }

  const service = createPreflightService({
    store,
    storageAdapter,
    analysisAdapter,
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  const file = new File([Buffer.from('%PDF')], 'test.pdf', { type: 'application/pdf' })
  const result = await service.createPreflight(file, 'user-1')

  assert.equal(createCalled, true, 'store.create should be called first')
  assert.equal(storageSaveCalled, true, 'storageAdapter.saveSource should be called')
  assert.equal(analysisCalled, true, 'analysisAdapter.analyzePdf should be called')
  assert.equal(updateCalled, true, 'store.update should be called last')
  assert.equal(result.id, 'preflight-1')
  assert.equal(result.status, 'ready')
  assert.equal(result.pages.length, 2)
})

test('createPreflight marks failed when analysis throws', async () => {
  let updateCalled = false
  const store = {
    create: async () => mockPreflightRecord({ status: 'uploaded' }),
    getOwned: async () => null,
    update: async (_id: string, _ownerId: string, patch: PreflightUpdatePatch) => {
      updateCalled = true
      assert.equal(patch.status, 'failed')
      return mockPreflightRecord({ ...patch, status: 'failed' })
    },
    deleteArtifacts: async () => false,
    claimExpired: async () => [],
  }

  const service = createPreflightService({
    store,
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => {
        throw new Error('Analysis failed')
      },
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  const file = new File([Buffer.from('%PDF')], 'test.pdf', { type: 'application/pdf' })
  await assert.rejects(async () => await service.createPreflight(file, 'user-1'), {
    message: 'Analysis failed',
  })

  assert.equal(updateCalled, true, 'store.update should be called to mark as failed')
})

test('consumePreflight validates ownership and status', async () => {
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord(),
      getOwned: async () => null,
      update: async () => null,
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  await assert.rejects(async () => await service.consumePreflight('preflight-1', 'user-1', { pages: [1] }), {
    message: 'Preflight not found',
  })
})

test('consumePreflight validates page selection', async () => {
  const record = mockPreflightRecord({ status: 'ready', pageCount: 2 })
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord(),
      getOwned: async () => record,
      update: async (_id: string, _ownerId: string, patch: PreflightUpdatePatch) => {
        assert.equal(patch.status, 'consumed')
        assert.deepEqual(patch.confirmedPages, [1])
        return { ...record, ...patch }
      },
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  const result = await service.consumePreflight('preflight-1', 'user-1', { pages: [1] })

  assert.equal(result.preflightId, 'preflight-1')
  assert.ok(result.file instanceof File)
  assert.deepEqual(result.pages, [1])
})

test('consumePreflight throws on invalid page selection', async () => {
  const record = mockPreflightRecord({ status: 'ready', pageCount: 2 })
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord(),
      getOwned: async () => record,
      update: async (_id: string, _ownerId: string, patch: PreflightUpdatePatch) => {
        assert.equal(patch.status, 'consumed')
        assert.deepEqual(patch.confirmedPages, [1])
        return { ...record, ...patch }
      },
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  // Test with invalid selection (empty array)
  await assert.rejects(async () => {
    await service.consumePreflight('preflight-1', 'user-1', { pages: [] as number[] })
  }, { message: /at least one page must be selected/ })
})

test('consumePreflight throws when status is not ready', async () => {
  const record = mockPreflightRecord({ status: 'uploaded' })
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord(),
      getOwned: async () => record,
      update: async () => null,
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  await assert.rejects(async () => await service.consumePreflight('preflight-1', 'user-1', { pages: [1] }), {
    message: 'Preflight is not ready',
  })
})

test('consumePreflight does NOT create Boq or ExtractionRun', async () => {
  let updateCalled = false
  const record = mockPreflightRecord({ status: 'ready', pageCount: 2 })
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord(),
      getOwned: async () => record,
      update: async (_id: string, _ownerId: string, patch: PreflightUpdatePatch) => {
        updateCalled = true
        assert.equal(patch.status, 'consumed')
        assert.ok(patch.confirmedPages !== undefined)
        assert.equal('createBoq' in patch, false)
        assert.equal('createRun' in patch, false)
        return { ...record, ...patch }
      },
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  await service.consumePreflight('preflight-1', 'user-1', { pages: [1] })

  assert.equal(updateCalled, true)
})

test('cancelPreflight marks record as cancelled', async () => {
  const record = mockPreflightRecord({ status: 'ready' })
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord(),
      getOwned: async () => record,
      update: async (_id: string, _ownerId: string, patch: PreflightUpdatePatch) => {
        assert.equal(patch.status, 'cancelled')
        return { ...record, ...patch }
      },
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  await service.cancelPreflight('preflight-1', 'user-1')
})

test('cancelPreflight throws on ownership mismatch', async () => {
  const service = createPreflightService({
    store: {
      create: async () => mockPreflightRecord(),
      getOwned: async () => null,
      update: async () => null,
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'path/to/source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: {
      analyzePdf: async () => [],
    },
    requireSinglePdf: (f) => f,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })

  await assert.rejects(async () => await service.cancelPreflight('preflight-1', 'user-1'), {
    message: 'Preflight not found',
  })
})
