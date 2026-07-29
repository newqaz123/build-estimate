import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDoclingResult } from './boq-ingestion'
import { v3Fixture } from './boq-extraction-test-fixtures'
import { parsePdfWithDocling } from './docling-client'

function pdfFile(): File {
  return new File([new Uint8Array([37, 80, 68, 70])], 'source.pdf', { type: 'application/pdf' })
}

test('parsePdfWithDocling sends the sorted selected original pages', async () => {
  const originalFetch = globalThis.fetch
  let request: RequestInit | undefined
  globalThis.fetch = async (_input, init) => {
    request = init
    return Response.json(v3Fixture())
  }
  try {
    await parsePdfWithDocling(pdfFile(), 'http://localhost:5001', undefined, { pages: [3, 1] })
    assert.equal((request?.body as FormData).get('pages'), '[1,3]')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('parsePdfWithDocling omits pages for the legacy direct import path', async () => {
  const originalFetch = globalThis.fetch
  let request: RequestInit | undefined
  globalThis.fetch = async (_input, init) => {
    request = init
    return Response.json(parseDoclingResult({
      contractVersion: 2,
      documentName: 'source.pdf',
      pageCount: 1,
      documentText: '',
      tables: [],
      sections: [],
      metadata: {
        vendor: { value: '', confidence: 0, source: '' },
        project: { value: '', confidence: 0, source: '' },
        date: { value: '', confidence: 0, source: '' },
        workType: { value: 'Unclassified', confidence: 0, source: '' },
      },
      warnings: [],
      totalItems: 0,
    }))
  }
  try {
    await parsePdfWithDocling(pdfFile(), 'http://localhost:5001')
    assert.equal((request?.body as FormData).get('pages'), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
