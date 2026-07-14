import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  DoclingClientError,
  buildDoclingParseUrl,
  parsePdfWithDocling,
} from '@/lib/docling-client'
import type { DoclingResultV2 } from '@/lib/boq-ingestion'
import { boqSourcePath, isSourceObjectNotFound } from '@/lib/boq-source-storage'
import { importPdfAtomically, requireSinglePdf } from './route'

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

test('buildDoclingParseUrl accepts only HTTP(S) and appends parse once', () => {
  assert.equal(buildDoclingParseUrl('http://localhost:5001'), 'http://localhost:5001/parse')
  assert.equal(buildDoclingParseUrl('https://docling.example/base/'), 'https://docling.example/base/parse')
  assert.equal(buildDoclingParseUrl('https://docling.example/base/parse/'), 'https://docling.example/base/parse')
  assert.throws(() => buildDoclingParseUrl('file:///tmp/docling'), /HTTP or HTTPS/)
})

test('parsePdfWithDocling sends the PDF without caching and validates the response', async () => {
  const originalFetch = globalThis.fetch
  let request: { input: string | URL | Request; init?: RequestInit } | undefined
  globalThis.fetch = async (input, init) => {
    request = { input, init }
    return Response.json(validDoclingPayload())
  }

  try {
    const file = new File([new Uint8Array([1, 2, 3])], 'bid.pdf', { type: 'application/pdf' })
    const parsed = await parsePdfWithDocling(file, 'http://localhost:5001/')

    assert.equal(parsed.documentName, 'bid.pdf')
    assert.equal(request?.input, 'http://localhost:5001/parse')
    assert.equal(request?.init?.method, 'POST')
    assert.equal(request?.init?.cache, 'no-store')
    assert.ok(request?.init?.body instanceof FormData)
    const uploaded = (request?.init?.body as FormData).get('file')
    assert.ok(uploaded instanceof File)
    assert.equal(uploaded.name, file.name)
    assert.deepEqual(Array.from(new Uint8Array(await uploaded.arrayBuffer())), [1, 2, 3])
    assert.ok(request?.init?.signal instanceof AbortSignal)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('parsePdfWithDocling categorizes rejected and invalid upstream responses safely', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ detail: 'PDF is encrypted', stack: 'secret' }, { status: 422 })
    await assert.rejects(
      () => parsePdfWithDocling(new File(['pdf'], 'bid.pdf'), 'http://localhost:5001'),
      (error) => error instanceof DoclingClientError
        && error.kind === 'rejected'
        && error.message.includes('PDF is encrypted')
        && !error.message.includes('secret'),
    )

    globalThis.fetch = async () => Response.json({ arbitrary: 'internal detail' })
    await assert.rejects(
      () => parsePdfWithDocling(new File(['pdf'], 'bid.pdf'), 'http://localhost:5001'),
      (error) => error instanceof DoclingClientError
        && error.kind === 'invalid_response'
        && !error.message.includes('internal detail'),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('parsePdfWithDocling categorizes aborts as timeout and network failures as unreachable', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
      throw new Error('unreachable')
    }
    const controller = new AbortController()
    const pending = parsePdfWithDocling(new File(['pdf'], 'bid.pdf'), 'http://localhost:5001', controller.signal)
    controller.abort()
    await assert.rejects(pending, (error) => error instanceof DoclingClientError && error.kind === 'timeout')

    globalThis.fetch = async () => { throw new TypeError('connect ECONNREFUSED with private details') }
    await assert.rejects(
      () => parsePdfWithDocling(new File(['pdf'], 'bid.pdf'), 'http://localhost:5001'),
      (error) => error instanceof DoclingClientError
        && error.kind === 'unreachable'
        && !error.message.includes('ECONNREFUSED'),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('source PDFs use the immutable BOQ source path', () => {
  assert.equal(boqSourcePath('0de99762-e891-4f68-9722-cf85ab353869'), 'boqs/0de99762-e891-4f68-9722-cf85ab353869/source.pdf')
  assert.equal(isSourceObjectNotFound({ code: 404 }), true)
  assert.equal(isSourceObjectNotFound({ code: 500 }), false)
  assert.equal(isSourceObjectNotFound(new Error('not found')), false)
})

test('requireSinglePdf accepts exactly one 1..20 MB PDF with matching extension and type', () => {
  const valid = new FormData()
  const pdf = new File(['pdf'], 'source.PDF', { type: 'application/pdf' })
  valid.append('file', pdf)
  assert.equal(requireSinglePdf(valid), valid.get('file'))

  const multiple = new FormData()
  multiple.append('file', pdf)
  multiple.append('file', pdf)
  assert.throws(() => requireSinglePdf(multiple), /one PDF/i)

  for (const invalid of [
    new File([], 'source.pdf', { type: 'application/pdf' }),
    new File(['pdf'], 'source.txt', { type: 'application/pdf' }),
    new File(['pdf'], 'source.pdf', { type: 'text/plain' }),
  ]) {
    const form = new FormData()
    form.append('file', invalid)
    assert.throws(() => requireSinglePdf(form), /one PDF/i)
  }
})

test('atomic import saves exact bytes, parses, and persists the draft', async () => {
  const calls: string[] = []
  let savedBytes: Uint8Array | undefined
  let persisted: Record<string, unknown> | undefined
  const file = new File([new Uint8Array([37, 80, 68, 70])], 'source.pdf', { type: 'application/pdf' })

  const draft = await importPdfAtomically(file, '0de99762-e891-4f68-9722-cf85ab353869', {
    getWorkspaceSettings: async () => ({ docling: { endpoint: 'https://docling.example' } }),
    saveSourcePdf: async (_path, bytes) => { calls.push('save'); savedBytes = bytes },
    parsePdfWithDocling: async (_file, endpoint) => {
      calls.push(`parse:${endpoint}`)
      return validDoclingPayload()
    },
    createDocumentWithId: async (collection, _id, data) => {
      calls.push(`persist:${collection}`)
      persisted = data
    },
    deleteSourcePdf: async () => { calls.push('delete') },
  })

  assert.deepEqual(Array.from(savedBytes ?? []), [37, 80, 68, 70])
  assert.deepEqual(calls, ['save', 'parse:https://docling.example', 'persist:boqs'])
  assert.equal(draft.status, 'draft')
  assert.equal(draft.sourceStoragePath, 'boqs/0de99762-e891-4f68-9722-cf85ab353869/source.pdf')
  assert.equal(persisted?.sourceStoragePath, draft.sourceStoragePath)
  assert.equal(draft.vendor, '')
  assert.equal(draft.date, '')
  assert.equal(draft.workType, 'Unclassified')
})

test('atomic import rolls back its source when parsing or persistence fails', async () => {
  for (const failAt of ['parse', 'persist'] as const) {
    const calls: string[] = []
    await assert.rejects(() => importPdfAtomically(
      new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
      '0de99762-e891-4f68-9722-cf85ab353869',
      {
        getWorkspaceSettings: async () => null,
        saveSourcePdf: async () => { calls.push('save') },
        parsePdfWithDocling: async () => {
          calls.push('parse')
          if (failAt === 'parse') throw new DoclingClientError('rejected', 'Docling rejected the PDF: unreadable document')
          return validDoclingPayload()
        },
        createDocumentWithId: async () => {
          calls.push('persist')
          if (failAt === 'persist') throw new Error('Firestore unavailable')
        },
        deleteSourcePdf: async () => { calls.push('delete') },
      },
    ))
    assert.equal(calls.at(-1), 'delete')
  }
})

test('atomic rollback ignores only object-not-found deletion failures', async () => {
  const parseError = new DoclingClientError('rejected', 'Docling rejected the PDF')
  const baseDependencies = {
    getWorkspaceSettings: async () => null,
    saveSourcePdf: async () => undefined,
    parsePdfWithDocling: async () => { throw parseError },
    createDocumentWithId: async () => undefined,
  }
  const file = new File(['pdf'], 'source.pdf', { type: 'application/pdf' })

  await assert.rejects(
    () => importPdfAtomically(file, crypto.randomUUID(), {
      ...baseDependencies,
      deleteSourcePdf: async () => { throw { code: 404 } },
    }),
    (error) => error === parseError,
  )

  const storageError = { code: 500 }
  await assert.rejects(
    () => importPdfAtomically(file, crypto.randomUUID(), {
      ...baseDependencies,
      deleteSourcePdf: async () => { throw storageError },
    }),
    (error) => error === storageError,
  )
})

test('import route authenticates and wires storage, parsing, persistence, and rollback', () => {
  const routeSource = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')
  assert.match(routeSource, /await auth\(\)/)
  assert.match(routeSource, /request\.formData\(\)/)
  assert.match(routeSource, /saveSourcePdf/)
  assert.match(routeSource, /parsePdfWithDocling/)
  assert.match(routeSource, /createDocumentWithId/)
  assert.match(routeSource, /deleteSourcePdf/)
})

test('source storage is private, non-resumable, and ignores only object-not-found deletion errors', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../../lib/boq-source-storage.ts', import.meta.url)), 'utf8')
  assert.match(source, /resumable:\s*false/)
  assert.match(source, /contentType:\s*['"]application\/pdf['"]/) 
  assert.match(source, /private,\s*max-age=0/)
  assert.match(source, /code\s*===\s*404/)
  assert.match(source, /file\(path\)\.delete\(\)/)
})

test('parse proxy reuses the shared Docling client', () => {
  const source = readFileSync(fileURLToPath(new URL('../../docling/parse/route.ts', import.meta.url)), 'utf8')
  assert.match(source, /from ['"]@\/lib\/docling-client['"]/) 
  assert.match(source, /parsePdfWithDocling/)
})
