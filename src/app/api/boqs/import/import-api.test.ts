import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Boq } from '@/lib/boq-schema'
import { parseDoclingResult, type DoclingResult, type DoclingResultV2 } from '@/lib/boq-ingestion'
import { v3Fixture } from '@/lib/boq-extraction-test-fixtures'
import type { ExtractionStore } from '@/lib/boq-extraction-storage'
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
import { createImportHandler } from './handler'
import { createDoclingParseHandler } from '../../docling/parse/handler'

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
    createRunId: () => 'run-1',
    now: () => new Date('2026-07-19T00:00:00.000Z'),
    extractionStore: extractionStore(),
    ...overrides,
  }
}

function extractionStore(overrides: Partial<ExtractionStore> = {}): ExtractionStore {
  return {
    createRun: async () => 'created',
    writeSourceRows: async () => undefined,
    verifySourceRows: async () => ({ count: 4, checksum: '' }),
    finalizeBoqAndRun: async () => 'finalized',
    getReadyImport: async () => null,
    getSourceRows: async () => [],
    cleanupStagingIfSafe: async () => true,
    deleteRunTree: async () => undefined,
    listExpiredStagingRuns: async () => [],
    ...overrides,
  }
}

function validV3Payload(): DoclingResult {
  return parseDoclingResult(v3Fixture())
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

test('v3 stages and verifies evidence before atomically finalizing BOQ and run', async () => {
  const events: string[] = []
  let expectedChecksum = ''
  const store = extractionStore({
    createRun: async (run) => { events.push('run:stage'); expectedChecksum = run.sourceRowChecksum; return 'created' },
    writeSourceRows: async () => { events.push('rows:write') },
    verifySourceRows: async () => { events.push('rows:verify'); return { count: 4, checksum: expectedChecksum } },
    finalizeBoqAndRun: async (boq, run) => {
      events.push('boq+run:finalize')
      assert.equal(boq.activeExtractionRunId, 'run-fixed')
      assert.equal(run.status, 'staging')
      return 'finalized'
    },
  })
  const result = await importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
    saveSourcePdf: async () => { events.push('source:save') },
    parsePdfWithDocling: async () => { events.push('parse:v3'); return validV3Payload() },
    createRunId: () => 'run-fixed',
    extractionStore: store,
    createDocumentWithId: async () => { events.push('v2:persist') },
  }))
  assert.equal(result.activeExtractionRunId, 'run-fixed')
  assert.deepEqual(events, ['source:save', 'parse:v3', 'run:stage', 'rows:write', 'rows:verify', 'boq+run:finalize'])
})

test('v3 staging failure cleans run then source, but uncertain cleanup preserves source', async () => {
  const calls: string[] = []
  await assert.rejects(() => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
    parsePdfWithDocling: async () => validV3Payload(),
    extractionStore: extractionStore({
      createRun: async () => 'created',
      writeSourceRows: async () => { throw new Error('write failed') },
      cleanupStagingIfSafe: async () => { calls.push('run:delete'); return true },
    }),
    deleteSourcePdf: async () => { calls.push('source:delete') },
  })))
  assert.deepEqual(calls, ['run:delete', 'source:delete'])

  calls.length = 0
  await assert.rejects(() => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
    parsePdfWithDocling: async () => validV3Payload(),
    extractionStore: extractionStore({
      createRun: async () => 'created',
      writeSourceRows: async () => { throw new Error('write failed') },
      cleanupStagingIfSafe: async () => { throw new Error('cleanup unknown') },
    }),
    deleteSourcePdf: async () => { calls.push('source:delete') },
  })))
  assert.deepEqual(calls, [])

  calls.length = 0
  let sourceDeleted = false
  await assert.rejects(
    () => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
      parsePdfWithDocling: async () => validV3Payload(),
      extractionStore: extractionStore({
        createRun: async () => 'exists_staging',
        writeSourceRows: async () => { throw new Error('shared run write failed') },
      }),
      deleteSourcePdf: async () => { sourceDeleted = true },
    })),
    /cleanup outcome is unknown/i,
  )
  assert.equal(sourceDeleted, false)
})

test('zero-item v3 import still finalizes a ready reviewable draft', async () => {
  const payload = v3Fixture()
  payload.sourceRows = []
  payload.sections = []
  payload.warnings = []
  payload.totalItems = 0
  payload.sourceTotal = null
  payload.reconciliation = { itemTotal: 0, sourceTotal: null, reconciled: false, difference: 0 }
  let checksum = ''
  let finalized = false
  const result = await importPdfAtomically(pdfFile(), 'boq-empty', serviceDependencies({
    parsePdfWithDocling: async () => parseDoclingResult(payload),
    extractionStore: extractionStore({
      createRun: async (run) => { checksum = run.sourceRowChecksum; return 'created' },
      verifySourceRows: async () => ({ count: 0, checksum }),
      finalizeBoqAndRun: async () => { finalized = true; return 'finalized' },
    }),
  }))
  assert.equal(result.totalItems, 0)
  assert.equal(finalized, true)
})

test('invalid caller-generated v3 run identity rolls back the saved source', async () => {
  const calls: string[] = []
  await assert.rejects(() => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
    parsePdfWithDocling: async () => validV3Payload(),
    createRunId: () => '',
    deleteSourcePdf: async () => { calls.push('source:delete') },
  })), /runId/i)
  assert.deepEqual(calls, ['source:delete'])
})

test('v3 run build failure rolls back the saved source', async () => {
  const calls: string[] = []
  await assert.rejects(() => importPdfAtomically(pdfFile(), 'boq-1', serviceDependencies({
    parsePdfWithDocling: async () => validV3Payload(),
    now: () => { throw new Error('clock unavailable') },
    deleteSourcePdf: async () => { calls.push('source:delete') },
  })), /clock unavailable/i)
  assert.deepEqual(calls, ['source:delete'])
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

test('atomic import forwards confirmed pages and fingerprints the selection', async () => {
  let receivedOptions: unknown
  let fingerprint = ''
  let checksum = ''
  await importPdfAtomically(
    pdfFile(),
    'boq-selected',
    serviceDependencies({
      parsePdfWithDocling: async (_file, _endpoint, _signal, options) => {
        receivedOptions = options
        return validV3Payload()
      },
      extractionStore: extractionStore({
        createRun: async (run) => { fingerprint = run.parser.configFingerprint; checksum = run.sourceRowChecksum; return 'created' },
        verifySourceRows: async () => ({ count: 4, checksum }),
      }),
    }),
    undefined,
    { preflightId: 'preflight-1', pages: [3, 1] },
  )
  assert.deepEqual(receivedOptions, { pages: [1, 3] })
  assert.notEqual(fingerprint, '')
})

test('preflight import uses the owned source and authoritative selected pages', async () => {
  let selection: unknown
  const imported = draftBoq('boq-from-preflight')
  const handler = createImportHandler({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    createId: () => 'boq-from-preflight',
    importPdf: async (_file, _id, _signal, confirmed) => {
      selection = confirmed
      return imported
    },
    consumePreflight: async (id, actorId, confirmed, operation) => {
      assert.equal(id, 'preflight-1')
      assert.equal(actorId, 'user-1')
      assert.deepEqual(confirmed.pages, [1, 3])
      assert.ok(operation)
      return {
        file: pdfFile(),
        pages: [2],
        preflightId: id,
        operationResult: await operation!({ file: pdfFile(), pages: [2], preflightId: id }),
      }
    },
  })
  const form = new FormData()
  form.set('preflightId', 'preflight-1')
  form.set('pages', '[3,1]')
  form.set('file', new File(['attacker bytes'], 'tampered.pdf', { type: 'application/pdf' }))
  const response = await handler(new Request('http://localhost/api', { method: 'POST', body: form }))
  assert.equal(response.status, 201)
  assert.deepEqual(selection, { preflightId: 'preflight-1', pages: [2] })
  assert.deepEqual(await response.json(), imported)
})

test('concurrent preflight imports return one 201 winner and one 409 loser', async () => {
  const record = {
    id: 'preflight-1', fileName: 'source.pdf', pageCount: 1, status: 'ready' as const,
    pages: [], confirmedPages: null, ownerId: 'user-1',
    sourceDigest: 'sha256:315d429b7714cedb6ad04ac31240145257692630457f3c88253c5beceac76027',
    sourceName: 'source.pdf', sourceType: 'application/pdf', sourceSize: 4,
    expiresAt: '2026-07-28T00:00:00.000Z', createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z',
  }
  let status: 'ready' | 'analyzing' | 'consumed' = 'ready'
  let reserveCalls = 0
  let release!: () => void
  const bothReserved = new Promise<void>((resolve) => { release = resolve })
  const service = (await import('@/lib/boq-preflight-service')).createPreflightService({
    store: {
      create: async () => record,
      getOwned: async () => ({ ...record, status: 'ready' as const }),
      update: async (_id, _ownerId, patch, conditions) => {
        if (patch.status === 'analyzing') {
          reserveCalls += 1
          if (reserveCalls === 2) release()
          await bothReserved
          if (status !== conditions?.expectedStatus) throw new Error(`Preflight status compare-and-set failed: expected ready, got ${status}`)
          status = 'analyzing'
          return { ...record, ...patch, status: 'analyzing' as const }
        }
        if (patch.status === 'consumed') { status = 'consumed'; return null }
        return { ...record, ...patch }
      },
      deleteArtifacts: async () => false,
      claimExpired: async () => [],
    },
    storageAdapter: {
      saveSource: async () => 'source.pdf',
      loadSource: async () => pdfFile([Buffer.from('%PDF')]),
    },
    analysisAdapter: { analyzePdf: async () => [] },
    requireSinglePdf: (file) => file,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  })
  let importCalls = 0
  const handler = createImportHandler({
    authenticate: async () => ({ user: { id: 'user-1' } }),
    createId: () => 'boq-1',
    consumePreflight: service.consumePreflight.bind(service),
    importPdf: async () => { importCalls += 1; return draftBoq('boq-1') },
  })
  const request = () => {
    const form = new FormData()
    form.set('preflightId', 'preflight-1')
    form.set('pages', '[1]')
    return new Request('http://localhost/api/boqs/import', { method: 'POST', body: form })
  }
  const responses = await Promise.all([handler(request()), handler(request())])
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409])
  assert.equal(importCalls, 1)
})

test('storage adapter stays private, non-resumable, and supports existence checks', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../../lib/boq-source-storage.ts', import.meta.url)), 'utf8')
  assert.match(source, /resumable:\s*false/)
  assert.match(source, /contentType:\s*['"]application\/pdf['"]/)
  assert.match(source, /private,\s*max-age=0/)
  assert.match(source, /\.exists\(\)/)
})
