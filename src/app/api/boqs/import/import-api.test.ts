import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Boq } from '@/lib/boq-schema'
import type { DoclingResultV2 } from '@/lib/boq-ingestion'
import {
  importPdfAtomically,
  type ImportServiceDependencies,
} from '@/lib/boq-import-service'
import { requireSinglePdf } from '@/lib/boq-import-request'
import { boqSourcePath, isSourceObjectNotFound } from '@/lib/boq-source-storage'
import {
  DoclingClientError,
  buildDoclingParseUrl,
  getAllowedDoclingOrigins,
  parsePdfWithDocling,
} from '@/lib/docling-client'
import { createImportHandler } from './route'
import { createDoclingParseHandler } from '../../docling/parse/route'

function validDoclingPayload(): DoclingResultV2 {
  return {
    contractVersion: 2,
    documentName: 'bid.pdf',
    pageCount: 1,
    documentText: 'Bid',
    tables: [],
    sections: [{
      header: 'Electrical',
      items: [{
        id: 'line-1',
        desc: 'Panel board',
        unit: 'ea',
        qty: 1,
        rate: 250,
        total: 250,
        type: 'unit',
        costComponent: 'combined',
        sourceRef: { page: 1, table: 1, row: 1 },
      }],
    }],
    metadata: {
      vendor: { value: '', confidence: 0, source: '' },
      project: { value: '', confidence: 0, source: '' },
      date: { value: '', confidence: 0, source: '' },
      workType: { value: 'Unclassified', confidence: 0, source: '' },
    },
    warnings: [],
    totalItems: 1,
  }
}

function pdfForm(...files: File[]): FormData {
  const form = new FormData()
  for (const file of files) form.append('file', file)
  return form
}

function pdfFile(bytes: BlobPart[] = ['pdf']): File {
  return new File(bytes, 'source.pdf', { type: 'application/pdf' })
}

function draftBoq(id = 'boq-1'): Boq {
  return {
    id,
    project: '',
    vendor: '',
    workType: 'Unclassified',
    date: '',
    totalItems: 1,
    grandTotal: 250,
    status: 'draft',
    stdStatus: 'none',
    sections: [],
    sourceStoragePath: `boqs/${id}/source.pdf`,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  }
}

function serviceDependencies(
  overrides: Partial<ImportServiceDependencies> = {},
): ImportServiceDependencies {
  return {
    getWorkspaceSettings: async () => null,
    saveSourcePdf: async () => undefined,
    sourcePdfExists: async () => true,
    parsePdfWithDocling: async () => validDoclingPayload(),
    createDocumentWithId: async () => undefined,
    getBoq: async () => null,
    deleteSourcePdf: async () => undefined,
    ...overrides,
  }
}

test('Docling URL policy permits localhost plus configured origins and targets one parse path', () => {
  const allowed = getAllowedDoclingOrigins(' https://docling.example:8443,https://second.example ')
  assert.deepEqual(allowed, new Set([
    'http://localhost:5001',
    'https://docling.example:8443',
    'https://second.example',
  ]))
  assert.equal(buildDoclingParseUrl('http://localhost:5001/base/parse/'), 'http://localhost:5001/base/parse')
  assert.equal(
    buildDoclingParseUrl('https://docling.example:8443/base/', allowed),
    'https://docling.example:8443/base/parse',
  )
})

test('Docling URL policy rejects arbitrary, private, and link-local origins', () => {
  for (const endpoint of [
    'https://attacker.example/parse',
    'http://10.0.0.8:5001',
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:5001',
    'file:///tmp/docling',
  ]) {
    assert.throws(
      () => buildDoclingParseUrl(endpoint),
      (error) => error instanceof DoclingClientError && error.kind === 'unreachable',
    )
  }
})

test('parsePdfWithDocling sends exact multipart bytes without caching or redirects', async () => {
  const originalFetch = globalThis.fetch
  let request: { input: string | URL | Request; init?: RequestInit } | undefined
  globalThis.fetch = async (input, init) => {
    request = { input, init }
    return Response.json(validDoclingPayload())
  }
  try {
    const parsed = await parsePdfWithDocling(pdfFile([new Uint8Array([1, 2, 3])]), ' http://localhost:5001/ ')
    assert.equal(parsed.documentName, 'bid.pdf')
    assert.equal(request?.input, 'http://localhost:5001/parse')
    assert.equal(request?.init?.method, 'POST')
    assert.equal(request?.init?.cache, 'no-store')
    assert.equal(request?.init?.redirect, 'error')
    const uploaded = (request?.init?.body as FormData).get('file')
    assert.ok(uploaded instanceof File)
    assert.deepEqual(Array.from(new Uint8Array(await uploaded.arrayBuffer())), [1, 2, 3])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Docling known document 400 and 422 responses become exact canned messages', async () => {
  const originalFetch = globalThis.fetch
  try {
    const cases = [
      [400, 'Only PDF files are supported /srv/secret.pdf', 'Only PDF files are supported'],
      [422, 'PDF size exceeds 20 MB; path=/private/upload', 'PDF must be between 1 byte and 20 MB'],
      [422, 'No BOQ rows found; token=secret', 'No BOQ line-item tables were found'],
    ] as const
    for (const [status, detail, expected] of cases) {
      globalThis.fetch = async () => Response.json({ detail }, { status })
      await assert.rejects(
        () => parsePdfWithDocling(pdfFile(), 'http://localhost:5001'),
        (error) => error instanceof DoclingClientError
          && error.kind === 'rejected'
          && error.message === expected
          && !error.message.includes('secret')
          && !error.message.includes('/private'),
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Docling auth, rate-limit, and unknown 4xx responses are generic upstream failures', async () => {
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    for (const [status, detail] of [
      [401, 'Only PDF files are supported secret=auth'],
      [403, 'Forbidden /private/policy'],
      [429, 'Rate limited token=secret'],
      [418, 'Unexpected client failure /srv/app'],
      [400, 'Parser failed at /srv/secrets/key.json'],
      [422, 'Unknown document problem token=abc'],
    ] as const) {
      globalThis.fetch = async () => Response.json({ detail }, { status })
      await assert.rejects(
        () => parsePdfWithDocling(pdfFile(), 'http://localhost:5001'),
        (error) => error instanceof DoclingClientError
          && error.kind === 'upstream'
          && !error.message.includes(detail)
          && !error.message.includes('secret')
          && !error.message.includes('/srv'),
      )
    }
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
  }
})

test('Docling 5xx is upstream without reflecting secrets or paths', async () => {
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  const logged: unknown[][] = []
  console.error = (...values: unknown[]) => { logged.push(values) }
  globalThis.fetch = async () => Response.json(
    { detail: 'AWS_SECRET=abc failed at /private/service.py' },
    { status: 503 },
  )
  try {
    await assert.rejects(
      () => parsePdfWithDocling(pdfFile(), 'http://localhost:5001'),
      (error) => error instanceof DoclingClientError
        && error.kind === 'upstream'
        && !error.message.includes('AWS_SECRET')
        && !error.message.includes('/private'),
    )
    assert.equal(JSON.stringify(logged).includes('AWS_SECRET'), false)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
  }
})

test('request cancellation is distinct from timeout', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    throw new Error('unreachable')
  }
  try {
    const controller = new AbortController()
    const pending = parsePdfWithDocling(pdfFile(), 'http://localhost:5001', controller.signal)
    controller.abort()
    await assert.rejects(
      pending,
      (error) => error instanceof DoclingClientError && error.kind === 'cancelled',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal Docling deadline aborts fetch as timeout', async (context) => {
  const originalFetch = globalThis.fetch
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = async (_input, init) => {
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    throw new Error('unreachable')
  }
  try {
    const pending = parsePdfWithDocling(pdfFile(), 'http://localhost:5001')
    context.mock.timers.tick(180_000)
    await assert.rejects(
      pending,
      (error) => error instanceof DoclingClientError && error.kind === 'timeout',
    )
  } finally {
    globalThis.fetch = originalFetch
    context.mock.timers.reset()
  }
})

test('network failures and invalid successful responses remain generic', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new TypeError('ECONNREFUSED secret-host') }
    await assert.rejects(
      () => parsePdfWithDocling(pdfFile(), 'http://localhost:5001'),
      (error) => error instanceof DoclingClientError
        && error.kind === 'unreachable'
        && !error.message.includes('secret-host'),
    )
    globalThis.fetch = async () => Response.json({ secret: '/private/schema' })
    await assert.rejects(
      () => parsePdfWithDocling(pdfFile(), 'http://localhost:5001'),
      (error) => error instanceof DoclingClientError
        && error.kind === 'invalid_response'
        && !error.message.includes('/private'),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shared upload validation requires one matching MIME and extension', () => {
  const pdf = pdfFile()
  assert.equal(requireSinglePdf(pdfForm(pdf)).name, 'source.pdf')
  assert.throws(() => requireSinglePdf(pdfForm(pdf, pdf)), /one PDF/i)
  assert.throws(() => requireSinglePdf(pdfForm(new File(['x'], 'source.txt', { type: 'application/pdf' }))), /one PDF/i)
  assert.throws(() => requireSinglePdf(pdfForm(new File(['x'], 'source.pdf', { type: 'text/plain' }))), /one PDF/i)
  assert.throws(() => requireSinglePdf(pdfForm(new File([], 'source.pdf', { type: 'application/pdf' }))), /one PDF/i)
})

test('source helpers use immutable path and only object-not-found', () => {
  assert.equal(boqSourcePath('boq-1'), 'boqs/boq-1/source.pdf')
  assert.equal(isSourceObjectNotFound({ code: 404 }), true)
  assert.equal(isSourceObjectNotFound({ code: 500 }), false)
})

test('atomic import saves exact bytes, propagates signal, and persists a draft', async () => {
  const calls: string[] = []
  let savedBytes: Uint8Array | undefined
  let persisted: Record<string, unknown> | undefined
  const controller = new AbortController()
  const draft = await importPdfAtomically(
    pdfFile([new Uint8Array([37, 80, 68, 70])]),
    'boq-1',
    serviceDependencies({
      getWorkspaceSettings: async () => ({ docling: { endpoint: ' http://localhost:5001 ' } }),
      saveSourcePdf: async (_path, bytes) => { calls.push('save'); savedBytes = bytes },
      parsePdfWithDocling: async (_file, endpoint, signal) => {
        calls.push(`parse:${endpoint}`)
        assert.equal(signal, controller.signal)
        return validDoclingPayload()
      },
      createDocumentWithId: async (_collection, _id, data) => { calls.push('persist'); persisted = data },
    }),
    controller.signal,
  )
  assert.deepEqual(Array.from(savedBytes ?? []), [37, 80, 68, 70])
  assert.deepEqual(calls, ['save', 'parse:http://localhost:5001', 'persist'])
  assert.equal(draft.status, 'draft')
  assert.equal(persisted?.sourceStoragePath, 'boqs/boq-1/source.pdf')
})

test('storage commit-then-reject reconciles existence and continues import', async () => {
  const calls: string[] = []
  const result = await importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
    saveSourcePdf: async () => { calls.push('save'); throw new Error('deadline after commit') },
    sourcePdfExists: async () => { calls.push('exists'); return true },
    parsePdfWithDocling: async () => { calls.push('parse'); return validDoclingPayload() },
    createDocumentWithId: async () => { calls.push('persist') },
    deleteSourcePdf: async () => { calls.push('delete') },
  }))
  assert.equal(result.status, 'draft')
  assert.deepEqual(calls, ['save', 'exists', 'parse', 'persist'])
})

test('storage rejection with confirmed absence fails without parsing or deletion', async () => {
  const calls: string[] = []
  const storageError = new Error('storage rejected')
  await assert.rejects(
    () => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
      saveSourcePdf: async () => { calls.push('save'); throw storageError },
      sourcePdfExists: async () => { calls.push('exists'); return false },
      parsePdfWithDocling: async () => { calls.push('parse'); return validDoclingPayload() },
      deleteSourcePdf: async () => { calls.push('delete') },
    })),
    (error) => error === storageError,
  )
  assert.deepEqual(calls, ['save', 'exists'])
})

test('Firestore commit-then-reject returns stored draft and preserves source', async () => {
  const calls: string[] = []
  const stored = draftBoq('boq-1')
  const result = await importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
    createDocumentWithId: async () => { calls.push('persist'); throw new Error('deadline after commit') },
    getBoq: async () => { calls.push('get'); return stored },
    deleteSourcePdf: async () => { calls.push('delete') },
  }))
  assert.equal(result, stored)
  assert.deepEqual(calls, ['persist', 'get'])
})

test('Firestore rejection deletes source only after confirming draft absence', async () => {
  const calls: string[] = []
  const persistenceError = new Error('Firestore rejected')
  await assert.rejects(
    () => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
      createDocumentWithId: async () => { calls.push('persist'); throw persistenceError },
      getBoq: async () => { calls.push('get'); return null },
      deleteSourcePdf: async () => { calls.push('delete') },
    })),
    (error) => error === persistenceError,
  )
  assert.deepEqual(calls, ['persist', 'get', 'delete'])
})

test('Firestore reconciliation failure preserves source because outcome is unknown', async () => {
  const calls: string[] = []
  const readError = new Error('Firestore read unavailable')
  await assert.rejects(
    () => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
      createDocumentWithId: async () => { calls.push('persist'); throw new Error('ambiguous write') },
      getBoq: async () => { calls.push('get'); throw readError },
      deleteSourcePdf: async () => { calls.push('delete') },
    })),
    (error) => error === readError,
  )
  assert.deepEqual(calls, ['persist', 'get'])
})

test('cancellation after parsing rolls back source and prevents persistence', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  await assert.rejects(
    () => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
      parsePdfWithDocling: async () => { calls.push('parse'); controller.abort(); return validDoclingPayload() },
      createDocumentWithId: async () => { calls.push('persist') },
      deleteSourcePdf: async () => { calls.push('delete') },
    }), controller.signal),
    (error) => error instanceof DoclingClientError && error.kind === 'cancelled',
  )
  assert.deepEqual(calls, ['parse', 'delete'])
})

test('rollback ignores object-not-found but surfaces other deletion failures', async () => {
  const parseError = new DoclingClientError('rejected', 'Docling rejected the PDF')
  await assert.rejects(
    () => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
      parsePdfWithDocling: async () => { throw parseError },
      deleteSourcePdf: async () => { throw { code: 404 } },
    })),
    (error) => error === parseError,
  )
  const rollbackError = { code: 500 }
  await assert.rejects(
    () => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
      parsePdfWithDocling: async () => { throw parseError },
      deleteSourcePdf: async () => { throw rollbackError },
    })),
    (error) => error === rollbackError,
  )
})

test('import and proxy handlers authenticate before reading multipart', async () => {
  const importHandler = createImportHandler({
    authenticate: async () => null,
    createId: () => 'boq-1',
    importPdf: async () => draftBoq(),
  })
  const proxyHandler = createDoclingParseHandler({
    authenticate: async () => null,
    getEndpoint: async () => 'http://localhost:5001',
    parsePdf: async () => validDoclingPayload(),
  })
  const request = new Request('http://localhost/api', { method: 'POST', body: 'not multipart' })
  assert.equal((await importHandler(request)).status, 401)
  assert.equal((await proxyHandler(request)).status, 401)
})

test('import and proxy handlers share invalid multipart and duplicate behavior', async () => {
  const importHandler = createImportHandler({
    authenticate: async () => ({ user: {} }),
    createId: () => 'boq-1',
    importPdf: async () => draftBoq(),
  })
  const proxyHandler = createDoclingParseHandler({
    authenticate: async () => ({ user: {} }),
    getEndpoint: async () => 'http://localhost:5001',
    parsePdf: async () => validDoclingPayload(),
  })
  for (const makeRequest of [
    () => new Request('http://localhost/api', { method: 'POST', body: '{}' }),
    () => new Request('http://localhost/api', { method: 'POST', body: pdfForm(pdfFile(), pdfFile()) }),
  ]) {
    assert.equal((await importHandler(makeRequest())).status, 400)
    assert.equal((await proxyHandler(makeRequest())).status, 400)
  }
})

test('import and proxy handlers share safe Docling category mapping', async () => {
  const categories = [
    ['cancelled', 499],
    ['timeout', 504],
    ['rejected', 422],
    ['unreachable', 502],
    ['upstream', 502],
    ['invalid_response', 502],
  ] as const
  for (const [kind, status] of categories) {
    const error = new DoclingClientError(kind, kind === 'rejected' ? 'Only PDF files are supported' : 'secret /private/path')
    const importHandler = createImportHandler({
      authenticate: async () => ({ user: {} }),
      createId: () => 'boq-1',
      importPdf: async () => { throw error },
    })
    const proxyHandler = createDoclingParseHandler({
      authenticate: async () => ({ user: {} }),
      getEndpoint: async () => 'http://localhost:5001',
      parsePdf: async () => { throw error },
    })
    for (const response of [
      await importHandler(new Request('http://localhost/api', { method: 'POST', body: pdfForm(pdfFile()) })),
      await proxyHandler(new Request('http://localhost/api', { method: 'POST', body: pdfForm(pdfFile()) })),
    ]) {
      assert.equal(response.status, status)
      const body = await response.text()
      assert.equal(body.includes('/private/path'), false)
      if (kind === 'rejected') assert.equal(body.includes('Only PDF'), true)
    }
  }
})

test('handler mapper never reflects a suffixed rejected message', async () => {
  const proxyHandler = createDoclingParseHandler({
    authenticate: async () => ({ user: {} }),
    getEndpoint: async () => 'http://localhost:5001',
    parsePdf: async () => {
      throw new DoclingClientError('rejected', 'Only PDF files are supported /private/secret.pdf')
    },
  })
  const response = await proxyHandler(new Request('http://localhost/api', {
    method: 'POST',
    body: pdfForm(pdfFile()),
  }))
  assert.equal(response.status, 422)
  const body = await response.text()
  assert.equal(body.includes('/private'), false)
  assert.equal(body.includes('secret'), false)
})

test('proxy settings lookup failure is generic infrastructure failure, not invalid upload', async () => {
  const originalConsoleError = console.error
  console.error = () => undefined
  const handler = createDoclingParseHandler({
    authenticate: async () => ({ user: {} }),
    getEndpoint: async () => { throw new Error('Firestore credentials /private/key.json') },
    parsePdf: async () => validDoclingPayload(),
  })
  try {
    const response = await handler(new Request('http://localhost/api', {
      method: 'POST',
      body: pdfForm(pdfFile()),
    }))
    assert.equal(response.status, 503)
    const body = await response.text()
    assert.equal(body.includes('Invalid upload'), false)
    assert.equal(body.includes('/private'), false)
  } finally {
    console.error = originalConsoleError
  }
})

test('handlers propagate request.signal and successful import returns 201', async () => {
  const controller = new AbortController()
  let importSignal: AbortSignal | undefined
  let proxySignal: AbortSignal | undefined
  const importHandler = createImportHandler({
    authenticate: async () => ({ user: {} }),
    createId: () => 'boq-1',
    importPdf: async (_file, _id, signal) => { importSignal = signal; return draftBoq() },
  })
  const proxyHandler = createDoclingParseHandler({
    authenticate: async () => ({ user: {} }),
    getEndpoint: async () => ' http://localhost:5001 ',
    parsePdf: async (_file, endpoint, signal) => {
      proxySignal = signal
      assert.equal(endpoint, 'http://localhost:5001')
      return validDoclingPayload()
    },
  })
  const importRequest = new Request('http://localhost/api', {
    method: 'POST',
    body: pdfForm(pdfFile()),
    signal: controller.signal,
  })
  const proxyRequest = new Request('http://localhost/api', {
    method: 'POST',
    body: pdfForm(pdfFile()),
    signal: controller.signal,
  })
  const importResponse = await importHandler(importRequest)
  const proxyResponse = await proxyHandler(proxyRequest)
  assert.equal(importResponse.status, 201)
  assert.equal(proxyResponse.status, 200)
  assert.equal(importSignal, importRequest.signal)
  assert.equal(proxySignal, proxyRequest.signal)
})

test('storage adapter stays private, non-resumable, and supports existence checks', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../../lib/boq-source-storage.ts', import.meta.url)), 'utf8')
  assert.match(source, /resumable:\s*false/)
  assert.match(source, /contentType:\s*['"]application\/pdf['"]/)
  assert.match(source, /private,\s*max-age=0/)
  assert.match(source, /\.exists\(\)/)
})
