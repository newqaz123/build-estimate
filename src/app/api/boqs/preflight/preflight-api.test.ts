import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreflightUpload } from '@/lib/boq-preflight-schema'
import { createPreflightHandlers } from '@/lib/boq-preflight-api'

type PreflightConsumeResult = { file: File; pages: number[]; preflightId: string }

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

const context = { params: Promise.resolve({ id: 'preflight-1' }) }

test('POST /api/boqs/preflight requires authentication before reading formData', async () => {
  const POST = createPreflightHandlers({
    authenticate: async () => null,
    createPreflight: async () => ({} as unknown as PreflightUpload),
    getPreflight: async () => null,
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
    cancelPreflight: async () => {},
  }).POST

  const formData = new FormData()
  formData.append('file', new File([Buffer.from('%PDF')], 'test.pdf', { type: 'application/pdf' }))
  const request = new Request('http://localhost/api/boqs/preflight', {
    method: 'POST',
    body: formData,
  })

  const response = await POST(request)

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
})

test('POST /api/boqs/preflight validates PDF before processing', async () => {
  let authenticated = false
  let validated = false
  const handlers = createPreflightHandlers({
    authenticate: async () => {
      authenticated = true
      return { user: {} }
    },
    createPreflight: async (file, actorId) => {
      validated = true
      assert.ok(file instanceof File)
      assert.equal(actorId, 'anonymous')
      return {
        id: 'preflight-1',
        fileName: 'test.pdf',
        pageCount: 2,
        status: 'ready' as const,
        pages: [],
        confirmedPages: null,
      }
    },
    requireSinglePdf: (file) => {
      validated = true
      if (!(file instanceof File)) throw new TypeError('Not a File')
      return file
    },
    getPreflight: async () => null,
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
    cancelPreflight: async () => {},
  })

  const formData = new FormData()
  formData.append('file', new File([Buffer.from('%PDF')], 'test.pdf', { type: 'application/pdf' }))
  const request = new Request('http://localhost/api/boqs/preflight', {
    method: 'POST',
    body: formData,
  })

  const response = await handlers.POST(request)

  assert.equal(authenticated, true, 'authentication should happen before formData')
  assert.equal(validated, true, 'validation should happen')
  assert.equal(response.status, 201)
  const body = await response.json()
  assert.equal(body.id, 'preflight-1')
  assert.equal('sourceDigest' in body, false, 'should not expose sourceDigest')
})

test('POST /api/boqs/preflight returns 400 for invalid PDF', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: {} }),
    createPreflight: async () => ({} as unknown as PreflightUpload),
    requireSinglePdf: () => {
      throw new TypeError('Upload one PDF between 1 byte and 20 MB.')
    },
    getPreflight: async () => null,
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
    cancelPreflight: async () => {},
  })

  const formData = new FormData()
  formData.append('file', new File([], 'test.txt', { type: 'text/plain' }))
  const request = new Request('http://localhost/api/boqs/preflight', {
    method: 'POST',
    body: formData,
  })

  const response = await handlers.POST(request)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Upload one PDF between 1 byte and 20 MB.' })
})

test('GET /api/boqs/preflight/[id] requires authentication', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => null,
    getPreflight: async () => null,
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
    cancelPreflight: async () => {},
  })

  const response = await handlers.GET(new Request('http://localhost/api/boqs/preflight/preflight-1'), context)

  assert.equal(response.status, 401)
})

test('GET /api/boqs/preflight/[id] returns 404 for other users preflight', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: { id: 'user-2' } }),
    getPreflight: async (id, ownerId) => {
      assert.equal(id, 'preflight-1')
      assert.equal(ownerId, 'user-2')
      return null
    },
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
    cancelPreflight: async () => {},
  })

  const response = await handlers.GET(new Request('http://localhost/api/boqs/preflight/preflight-1'), context)

  assert.equal(response.status, 404)
})

test('GET /api/boqs/preflight/[id] returns safe metadata only', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    getPreflight: async () => mockPreflightUpload(),
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
    cancelPreflight: async () => {},
  })

  const response = await handlers.GET(new Request('http://localhost/api/boqs/preflight/preflight-1'), context)

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.id, 'preflight-1')
  assert.equal(body.fileName, 'test.pdf')
  assert.equal(body.pageCount, 2)
  assert.equal(body.status, 'ready')
  assert.ok(Array.isArray(body.pages))
  assert.equal('sourceDigest' in body, false, 'should not expose sourceDigest')
  assert.equal('sourceStoragePath' in body, false, 'should not expose storage path')
})

test('PATCH /api/boqs/preflight/[id] requires authentication', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => null,
    consumePreflight: async () => ({} as unknown as PreflightConsumeResult),
    getPreflight: async () => null,
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    cancelPreflight: async () => {},
  })

  const response = await handlers.PATCH(new Request('http://localhost/api/boqs/preflight/preflight-1', {
    method: 'PATCH',
    body: JSON.stringify({ pages: [1] }),
  }), context)

  assert.equal(response.status, 401)
})

test('PATCH /api/boqs/preflight/[id] validates ownership and readiness', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    getPreflight: async () => mockPreflightUpload({ pageCount: 2 }),
    consumePreflight: async (id, actorId, selection) => {
      assert.equal(id, 'preflight-1')
      assert.equal(actorId, 'user-1')
      assert.deepEqual(selection, { pages: [1] })
      return {
        file: new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
        pages: [1],
        preflightId: 'preflight-1',
      }
    },
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    cancelPreflight: async () => {},
  })

  const response = await handlers.PATCH(new Request('http://localhost/api/boqs/preflight/preflight-1', {
    method: 'PATCH',
    body: JSON.stringify({ pages: [1] }),
  }), context)

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.preflightId, 'preflight-1')
  assert.deepEqual(body.pages, [1])
  assert.equal('sourceDigest' in body, false)
})

test('PATCH /api/boqs/preflight/[id] returns 400 for invalid page selection', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    getPreflight: async () => mockPreflightUpload({ pageCount: 2 }),
    consumePreflight: async () => ({} as unknown as PreflightConsumeResult),
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    cancelPreflight: async () => {},
  })

  const response = await handlers.PATCH(new Request('http://localhost/api/boqs/preflight/preflight-1', {
    method: 'PATCH',
    body: JSON.stringify({ pages: [] }),
  }), context)

  assert.equal(response.status, 400)
  assert.ok((await response.json()).error.includes('Invalid confirmed page selection'))
})

test('PATCH /api/boqs/preflight/[id] returns 404 for other users preflight', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: { id: 'user-2' } }),
    getPreflight: async () => null,
    consumePreflight: async () => {
      throw new Error('Preflight not found')
    },
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    cancelPreflight: async () => {},
  })

  const response = await handlers.PATCH(new Request('http://localhost/api/boqs/preflight/preflight-1', {
    method: 'PATCH',
    body: JSON.stringify({ pages: [1] }),
  }), context)

  assert.equal(response.status, 404)
})

test('DELETE /api/boqs/preflight/[id] requires authentication', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => null,
    cancelPreflight: async () => undefined,
    getPreflight: async () => null,
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
  })

  const response = await handlers.DELETE(new Request('http://localhost/api/boqs/preflight/preflight-1', { method: 'DELETE' }), context)

  assert.equal(response.status, 401)
})

test('DELETE /api/boqs/preflight/[id] validates ownership', async () => {
  let cancelled = false
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    cancelPreflight: async (id, actorId) => {
      assert.equal(id, 'preflight-1')
      assert.equal(actorId, 'user-1')
      cancelled = true
    },
    getPreflight: async () => null,
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
  })

  const response = await handlers.DELETE(new Request('http://localhost/api/boqs/preflight/preflight-1', { method: 'DELETE' }), context)

  assert.equal(cancelled, true)
  assert.equal(response.status, 204)
})

test('DELETE /api/boqs/preflight/[id] returns 404 for other users preflight', async () => {
  const handlers = createPreflightHandlers({
    authenticate: async () => ({ user: { id: 'user-2' } }),
    cancelPreflight: async () => {
      throw new Error('Preflight not found')
    },
    getPreflight: async () => null,
    createPreflight: async () => ({ id: '', fileName: '', pageCount: 0, status: 'uploaded' as const, pages: [], confirmedPages: null }),
    consumePreflight: async () => ({ file: new File([], 'source.pdf'), pages: [], preflightId: '' }),
  })

  const response = await handlers.DELETE(new Request('http://localhost/api/boqs/preflight/preflight-1', { method: 'DELETE' }), context)

  assert.equal(response.status, 404)
})
