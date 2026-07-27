import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreflightUpload, PreflightPage, PreflightRecord } from '@/lib/boq-preflight-schema'
import type { PreflightStore } from '@/lib/boq-preflight-storage'
import { createPreflightService } from '@/lib/boq-preflight-service'

const mockPdf = new File(['%PDF-1.4'], 'test.pdf', { type: 'application/pdf' })

function mockStore(): PreflightStore {
  const records = new Map<string, PreflightUpload & { ownerId: string }>()
  return {
    async create(input) {
      const record = { ...input, id: input.id || 'mock-id', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      records.set(`${input.ownerId}:${record.id}`, record)
      return Promise.resolve(record as unknown as PreflightRecord)
    },
    async getOwned(id, ownerId) {
      return Promise.resolve(records.get(`${ownerId}:${id}`) as unknown as PreflightRecord || null)
    },
    async update(id, ownerId, patch) {
      const key = `${ownerId}:${id}`
      const existing = records.get(key)
      if (!existing) return Promise.resolve(null)
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() }
      records.set(key, updated)
      return Promise.resolve(updated as unknown as PreflightRecord)
    },
    async deleteArtifacts(id, ownerId) {
      return Promise.resolve(records.delete(`${ownerId}:${id}`))
    },
    async claimExpired() { return Promise.resolve([]) },
  }
}

interface AnalysisAdapter {
  renderAndAnalyze(file: File, signal: AbortSignal): Promise<{ pageCount: number; pages: PreflightPage[] }>
  renderPreview(file: File, pageNumber: number): Promise<Buffer>
}

function mockAnalysisAdapter(overrides: Partial<AnalysisAdapter> = {}): AnalysisAdapter {
  return {
    async renderAndAnalyze(_file: File, _signal: AbortSignal) {
      return {
        pageCount: 3,
        pages: [
          { page: 1, suggested: true, confidence: 0.95, reasons: ['Table detected'], textSource: 'embedded' },
          { page: 2, suggested: false, confidence: 0.5, reasons: ['Image only'], textSource: 'ocr' },
          { page: 3, suggested: false, confidence: 0.3, reasons: ['Blank page'], textSource: 'unavailable' },
        ],
      }
    },
    async renderPreview(_file: File, _pageNumber: number) {
      return Buffer.from('mock-preview')
    },
    ...overrides,
  }
}

function mockStorageAdapter() {
  const storedFiles = new Map<string, { file: File; buffer: Buffer }>()
  return {
    async saveSourcePdf(ownerId: string, id: string, file: File): Promise<string> {
      const path = `preflight/${ownerId}/${id}/source.pdf`
      storedFiles.set(path, { file, buffer: Buffer.from(await file.arrayBuffer()) })
      return path
    },
    async loadSourcePdf(path: string): Promise<File> {
      const stored = storedFiles.get(path)
      if (!stored) throw new Error('Source PDF not found')
      return stored.file
    },
    storedFiles,
  }
}

test('createPreflight validates with requireSinglePdf and rejects invalid files', async () => {
  const service = createPreflightService({
    store: mockStore(),
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const invalidFile = new File(['not pdf'], 'test.txt', { type: 'text/plain' })
  await assert.rejects(
    () => service.createPreflight(invalidFile, 'user-1'),
    { message: /Upload one PDF between 1 byte and 20 MB/ }
  )
})

test('createPreflight stores source, renders/analyzes pages, and returns page metadata', async () => {
  const storageAdapter = mockStorageAdapter()
  const service = createPreflightService({
    store: mockStore(),
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter,
    now: () => new Date('2026-07-27T10:00:00.000Z'),
  })

  const result = await service.createPreflight(mockPdf, 'user-1')

  assert.equal(result.fileName, 'test.pdf')
  assert.equal(result.pageCount, 3)
  assert.equal(result.status, 'ready')
  assert.equal(result.pages.length, 3)
  assert.deepEqual(result.pages[0], {
    page: 1,
    suggested: true,
    confidence: 0.95,
    reasons: ['Table detected'],
    textSource: 'embedded',
  })
  assert.equal(storageAdapter.storedFiles.size, 1)
  assert.ok(storageAdapter.storedFiles.has(`preflight/user-1/${result.id}/source.pdf`))
})

test('createPreflight returns unavailable pages when analysis fails partially', async () => {
  const service = createPreflightService({
    store: mockStore(),
    analysisAdapter: mockAnalysisAdapter({
      async renderAndAnalyze(_file: File, _signal: AbortSignal) {
        return {
          pageCount: 2,
          pages: [
            { page: 1, suggested: false, confidence: 0, reasons: [], textSource: 'unavailable' },
            { page: 2, suggested: false, confidence: 0, reasons: [], textSource: 'unavailable' },
          ],
        }
      },
    }),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const result = await service.createPreflight(mockPdf, 'user-1')

  assert.equal(result.status, 'ready')
  assert.equal(result.pages.length, 2)
  assert.equal(result.pages[0].textSource, 'unavailable')
  assert.equal(result.pages[0].suggested, false)
})

test('consumePreflight validates ownership and returns {file, pages, preflightId} without creating BOQ', async () => {
  const storageAdapter = mockStorageAdapter()
  const store = mockStore()
  const service = createPreflightService({
    store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter,
    now: () => new Date(),
  })

  const created = await service.createPreflight(mockPdf, 'user-1')
  const consumed = await service.consumePreflight(created.id, 'user-1', { pages: [1, 2] })

  assert.equal(consumed.preflightId, created.id)
  assert.equal(consumed.pages.length, 2)
  assert.ok(consumed.file instanceof File)
  assert.equal(consumed.file.name, 'test.pdf')
})

test('consumePreflight rejects requests from non-owners', async () => {
  const store = mockStore()
  const service = createPreflightService({
    store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const created = await service.createPreflight(mockPdf, 'user-1')

  await assert.rejects(
    () => service.consumePreflight(created.id, 'user-2', { pages: [1] }),
    { message: /Preflight upload not found/ }
  )
})

test('consumePreflight validates page selection and rejects empty selections', async () => {
  const service = createPreflightService({
    store: mockStore(),
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const created = await service.createPreflight(mockPdf, 'user-1')

  await assert.rejects(
    () => service.consumePreflight(created.id, 'user-1', { pages: [] }),
    { message: /at least one page must be selected/ }
  )
})

test('cancelPreflight marks upload as cancelled and triggers cleanup', async () => {
  const storageAdapter = mockStorageAdapter()
  const store = mockStore()
  const service = createPreflightService({
    store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter,
    now: () => new Date(),
  })

  const created = await service.createPreflight(mockPdf, 'user-1')
  await service.cancelPreflight(created.id, 'user-1')

  const updated = await store.getOwned(created.id, 'user-1')
  assert.equal(updated?.status, 'cancelled')
})

test('cancelPreflight rejects cancellation by non-owner', async () => {
  const store = mockStore()
  const service = createPreflightService({
    store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const created = await service.createPreflight(mockPdf, 'user-1')

  await assert.rejects(
    () => service.cancelPreflight(created.id, 'user-2'),
    { message: /Preflight upload not found/ }
  )
})
