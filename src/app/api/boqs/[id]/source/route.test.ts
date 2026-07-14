import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from '@/lib/boq-schema'
import { createSourceHandler } from './route'

function sourceBoq(overrides: Partial<Boq> = {}): Boq {
  return {
    id: 'boq-1',
    project: 'Tower',
    vendor: 'Acme',
    workType: 'Structural',
    date: '2026-07-15',
    totalItems: 1,
    grandTotal: 200,
    status: 'draft',
    stdStatus: 'none',
    sections: [],
    sourceFileName: 'Acme quote.pdf',
    sourceStoragePath: 'boqs/boq-1/source.pdf',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  }
}

const context = { params: Promise.resolve({ id: 'boq-1' }) }

test('source GET requires authentication', async () => {
  const GET = createSourceHandler({
    authenticate: async () => null,
    getBoq: async () => sourceBoq(),
    loadSource: async () => Buffer.from('unused'),
  })

  const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)

  assert.equal(response.status, 401)
})

test('source GET returns 404 for a missing BOQ or storage path', async (t) => {
  for (const [name, stored] of [
    ['missing BOQ', null],
    ['missing path', sourceBoq({ sourceStoragePath: undefined })],
  ] as const) {
    await t.test(name, async () => {
      const GET = createSourceHandler({
        authenticate: async () => ({ user: {} }),
        getBoq: async () => stored,
        loadSource: async () => Buffer.from('unused'),
      })
      const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)
      assert.equal(response.status, 404)
    })
  }
})

test('source GET maps a missing storage object to 404 and other load failures to a generic 500', async (t) => {
  for (const [name, error, status] of [
    ['missing object', { code: 404 }, 404],
    ['storage failure', new Error('secret bucket details'), 500],
  ] as const) {
    await t.test(name, async () => {
      const GET = createSourceHandler({
        authenticate: async () => ({ user: {} }),
        getBoq: async () => sourceBoq(),
        loadSource: async () => { throw error },
      })
      const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)
      assert.equal(response.status, status)
      if (status === 500) assert.deepEqual(await response.json(), { error: 'Internal server error' })
    })
  }
})

test('source GET streams exact private PDF bytes with a safe inline filename and no public URL', async () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
  let loadedPath = ''
  const GET = createSourceHandler({
    authenticate: async () => ({ user: {} }),
    getBoq: async () => sourceBoq({ sourceFileName: 'quote "หนึ่ง".pdf' }),
    loadSource: async (path) => {
      loadedPath = path
      return bytes
    },
  })

  const response = await GET(new Request('http://localhost/api/boqs/boq-1/source'), context)

  assert.equal(response.status, 200)
  assert.equal(loadedPath, 'boqs/boq-1/source.pdf')
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const disposition = response.headers.get('content-disposition') ?? ''
  assert.match(disposition, /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/)
  assert.doesNotMatch(disposition, /[\r\n]/)
  assert.equal(response.headers.get('location'), null)
  assert.doesNotMatch([...response.headers.values()].join(' '), /firebase|storage\.googleapis|https?:\/\//i)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
})
