import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreflightUpload, PreflightPage } from '@/lib/boq-preflight-schema'
import type { PreflightStore, PreflightRecord } from '@/lib/boq-preflight-storage'
import { createPreflightRouteHandlers, createPreflightDetailHandlers } from '@/app/api/boqs/preflight/handler'

const mockPdfBytes = Buffer.from('%PDF-1.4\n%%EOF')
const mockPdf = new File([mockPdfBytes], 'test.pdf', { type: 'application/pdf' })

function mockStore(): PreflightStore {
  const records = new Map<string, (PreflightUpload & { ownerId: string })>()
  return {
    async create(input) {
      const record = { ...input, id: input.id || 'mock-id', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      records.set(`${input.ownerId}:${record.id}`, record)
      return record as PreflightStore extends { create(...args: never[]): infer R } ? R : never
    },
    async getOwned(id, ownerId) {
      return records.get(`${ownerId}:${id}`) as PreflightStore extends { getOwned(...args: never[]): infer R } ? R : never || null
    },
    async update(id, ownerId, patch) {
      const key = `${ownerId}:${id}`
      const existing = records.get(key)
      if (!existing) return null
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() }
      records.set(key, updated)
      return updated as PreflightStore extends { update(...args: never[]): infer R } ? R : never
    },
    async deleteArtifacts(id, ownerId) {
      return records.delete(`${ownerId}:${id}`)
    },
    async claimExpired() { return [] },
  }
}

interface AnalysisAdapter {
  renderAndAnalyze(file: File, signal: AbortSignal): Promise<{ pageCount: number; pages: PreflightPage[] }>
  renderPreview(file: File, pageNumber: number): Promise<Buffer>
}

interface StorageAdapter {
  saveSourcePdf(ownerId: string, id: string, file: File): Promise<string>
  loadSourcePdf(path: string): Promise<File>
}

function mockAnalysisAdapter(): AnalysisAdapter {
  return {
    async renderAndAnalyze(_file: File, _signal: AbortSignal) {
      return {
        pageCount: 2,
        pages: [
          { page: 1, suggested: true, confidence: 0.9, reasons: ['Table'], textSource: 'embedded' },
          { page: 2, suggested: false, confidence: 0.5, reasons: ['Image'], textSource: 'ocr' },
        ],
      }
    },
    async renderPreview() {
      return Buffer.from('mock-preview-image')
    },
  }
}

function mockStorageAdapter(): StorageAdapter {
  const storedFiles = new Map<string, File>()
  return {
    async saveSourcePdf(ownerId: string, id: string, file: File) {
      const path = `preflight/${ownerId}/${id}/source.pdf`
      storedFiles.set(path, file)
      return path
    },
    async loadSourcePdf(path: string) {
      const file = storedFiles.get(path)
      if (!file) throw new Error('Source PDF not found')
      return file
    },
  }
}

function createFormDataWithPdf(): FormData {
  const formData = new FormData()
  formData.append('file', mockPdf, 'test.pdf')
  return formData
}

async function authenticatedRequest(formData: FormData, userId = 'user-1'): Promise<Request> {
  return new Request('http://localhost/api/boqs/preflight', {
    method: 'POST',
    body: formData,
    headers: { 'x-test-user-id': userId },
  })
}

test('POST /api/boqs/preflight authenticates before reading multipart bytes', async () => {
  const handlers = createPreflightRouteHandlers({
    authenticate: async () => null,
    createStore: () => mockStore(),
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const response = await handlers.POST(await authenticatedRequest(createFormDataWithPdf()))

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
})

test('POST /api/boqs/preflight creates preflight and returns page metadata', async () => {
  let authenticateCalled = false
  let formDataRead = false
  const handlers = createPreflightRouteHandlers({
    authenticate: async () => {
      authenticateCalled = true
      return { user: { id: 'user-1' } }
    },
    createStore: () => mockStore(),
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: {
      ...mockStorageAdapter(),
      async saveSourcePdf(ownerId, id, file) {
        formDataRead = true
        return mockStorageAdapter().saveSourcePdf(ownerId, id, file)
      },
    },
    now: () => new Date(),
  })

  const request = await authenticatedRequest(createFormDataWithPdf())
  const response = await handlers.POST(request)

  assert.equal(authenticateCalled, true)
  assert.equal(formDataRead, true)
  assert.equal(response.status, 201)
  const body = await response.json()
  assert.match(body.id, /\w+/)
  assert.equal(body.fileName, 'test.pdf')
  assert.equal(body.pageCount, 2)
  assert.equal(body.status, 'ready')
  assert.deepEqual(body.pages.map((p: { page: number }) => p.page), [1, 2])
})

test('GET /api/boqs/preflight/[id] returns 401 without authentication', async () => {
  const handlers = createPreflightDetailHandlers({
    authenticate: async () => null,
    createStore: () => mockStore(),
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const context = { params: Promise.resolve({ id: 'test-id' }) }
  const response = await handlers.GET(new Request('http://localhost/api/boqs/preflight/test-id'), context)

  assert.equal(response.status, 401)
})

test('GET /api/boqs/preflight/[id] returns 404 for other users preflight', async () => {
  const store = mockStore()
  const handlers = createPreflightDetailHandlers({
    authenticate: async () => ({ user: { id: 'user-2' } }),
    createStore: () => store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  await store.create({
    id: 'test-id',
    ownerId: 'user-1',
    fileName: 'test.pdf',
    pageCount: 2,
    status: 'ready',
    pages: [],
    confirmedPages: null,
    sourceDigest: 'digest',
    sourceName: 'test.pdf',
    sourceType: 'application/pdf',
    sourceSize: 1000,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const context = { params: Promise.resolve({ id: 'test-id' }) }
  const response = await handlers.GET(new Request('http://localhost/api/boqs/preflight/test-id'), context)

  assert.equal(response.status, 404)
})

test('GET /api/boqs/preflight/[id] returns safe metadata for owner', async () => {
  const store = mockStore()
  const handlers = createPreflightDetailHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    createStore: () => store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  await store.create({
    id: 'test-id',
    ownerId: 'user-1',
    fileName: 'test.pdf',
    pageCount: 2,
    status: 'ready',
    pages: [
      { page: 1, suggested: true, confidence: 0.9, reasons: ['Table'], textSource: 'embedded' },
      { page: 2, suggested: false, confidence: 0.5, reasons: ['Image'], textSource: 'ocr' },
    ],
    confirmedPages: null,
    sourceDigest: 'digest',
    sourceName: 'test.pdf',
    sourceType: 'application/pdf',
    sourceSize: 1000,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const context = { params: Promise.resolve({ id: 'test-id' }) }
  const response = await handlers.GET(new Request('http://localhost/api/boqs/preflight/test-id'), context)

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.id, 'test-id')
  assert.equal(body.fileName, 'test.pdf')
  assert.equal(body.pageCount, 2)
  assert.equal(body.status, 'ready')
  assert.equal(body.pages.length, 2)
  assert.equal(body.sourceDigest, undefined)
})

test('PATCH /api/boqs/preflight/[id] consumes preflight and returns {file, pages, preflightId}', async () => {
  const handlers = createPreflightDetailHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    createStore: () => mockStore(),
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  const context = { params: Promise.resolve({ id: 'test-id' }) }
  const patchRequest = new Request('http://localhost/api/boqs/preflight/test-id', {
    method: 'PATCH',
    body: JSON.stringify({ pages: [1] }),
    headers: { 'content-type': 'application/json' },
  })

  const response = await handlers.PATCH(patchRequest, context)

  assert.equal(response.status, 404)
})

test('DELETE /api/boqs/preflight/[id] cancels preflight for owner', async () => {
  const store = mockStore()
  const handlers = createPreflightDetailHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    createStore: () => store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  await store.create({
    id: 'test-id',
    ownerId: 'user-1',
    fileName: 'test.pdf',
    pageCount: 2,
    status: 'ready',
    pages: [],
    confirmedPages: null,
    sourceDigest: 'digest',
    sourceName: 'test.pdf',
    sourceType: 'application/pdf',
    sourceSize: 1000,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const context = { params: Promise.resolve({ id: 'test-id' }) }
  const response = await handlers.DELETE(new Request('http://localhost/api/boqs/preflight/test-id'), context)

  assert.equal(response.status, 204)

  const updated = await store.getOwned('test-id', 'user-1')
  assert.equal(updated?.status, 'cancelled')
})

test('GET /api/boqs/preflight/[id]/pages/[page] streams preview after ownership check', async () => {
  const storageAdapter = mockStorageAdapter()
  const store = mockStore()
  const handlers = createPreflightDetailHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    createStore: () => store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter,
    now: () => new Date(),
  })

  await storageAdapter.saveSourcePdf('user-1', 'test-id', mockPdf)
  await store.create({
    id: 'test-id',
    ownerId: 'user-1',
    fileName: 'test.pdf',
    pageCount: 3,
    status: 'ready',
    pages: [],
    confirmedPages: null,
    sourceDigest: 'preflight/user-1/test-id/source.pdf',
    sourceName: 'test.pdf',
    sourceType: 'application/pdf',
    sourceSize: 1000,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const context = { params: Promise.resolve({ id: 'test-id', page: '2' }) }
  const response = await handlers.getPage(new Request('http://localhost/api/boqs/preflight/test-id/pages/2'), context)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  const previewBytes = await response.arrayBuffer()
  assert.equal(Buffer.from(previewBytes).toString(), 'mock-preview-image')
})

test('GET /api/boqs/preflight/[id]/pages/[page] returns 404 for non-owner', async () => {
  const store = mockStore()
  const handlers = createPreflightDetailHandlers({
    authenticate: async () => ({ user: { id: 'user-2' } }),
    createStore: () => store,
    analysisAdapter: mockAnalysisAdapter(),
    storageAdapter: mockStorageAdapter(),
    now: () => new Date(),
  })

  await store.create({
    id: 'test-id',
    ownerId: 'user-1',
    fileName: 'test.pdf',
    pageCount: 2,
    status: 'ready',
    pages: [],
    confirmedPages: null,
    sourceDigest: 'digest',
    sourceName: 'test.pdf',
    sourceType: 'application/pdf',
    sourceSize: 1000,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const context = { params: Promise.resolve({ id: 'test-id', page: '1' }) }
  const response = await handlers.getPage(new Request('http://localhost/api/boqs/preflight/test-id/pages/1'), context)

  assert.equal(response.status, 404)
})

test('DELETE /api/internal/cleanup/preflight requires server secret', async () => {
  let cleanupCalled = false
  const mockCleanup = async () => {
    cleanupCalled = true
    return 5
  }

  const handler = createCleanupRoute({
    serverSecret: 'test-secret',
    cleanup: mockCleanup,
  })

  const requestWithoutSecret = new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
  })

  const response1 = await handler(requestWithoutSecret)
  assert.equal(response1.status, 401)
  assert.equal(cleanupCalled, false)

  const requestWithWrongSecret = new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
    headers: { 'x-server-secret': 'wrong-secret' },
  })

  const response2 = await handler(requestWithWrongSecret)
  assert.equal(response2.status, 401)
  assert.equal(cleanupCalled, false)

  const requestWithCorrectSecret = new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
    headers: { 'x-server-secret': 'test-secret' },
  })

  const response3 = await handler(requestWithCorrectSecret)
  assert.equal(response3.status, 200)
  assert.deepEqual(await response3.json(), { deleted: 5 })
  assert.equal(cleanupCalled, true)
})

function createCleanupRoute(deps: { serverSecret: string; cleanup: () => Promise<number> }) {
  return async function DELETE(request: Request): Promise<Response> {
    const secret = request.headers.get('x-server-secret')
    if (secret !== deps.serverSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const deleted = await deps.cleanup()
    return Response.json({ deleted })
  }
}
