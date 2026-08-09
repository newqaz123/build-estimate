import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCatalogConversionsDeleteHandler,
  createCatalogConversionsGetHandler,
  createCatalogConversionsPostHandler,
} from './route'
import type { HumanApprovedCatalogConversionRule } from '@/lib/catalog-conversion'
import { CatalogConversionStorageError } from '@/lib/catalog-conversion-storage'

function postRequest(body: unknown) {
  return new Request('https://example.test/api/catalog-conversions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteRequest(body: unknown) {
  return new Request('https://example.test/api/catalog-conversions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const sampleRule: HumanApprovedCatalogConversionRule = {
  id: 'rule-1',
  sourceUnit: 'length',
  catalogUnit: 'm',
  catalogUnitsPerSourceUnit: '6',
  scope: 'catalog_item',
  catalogId: 'pipe-100',
  version: 1,
  approvedBy: 'admin-1',
  approvedAt: '2026-08-08T10:00:00.000Z',
}

test('POST requires authentication before creating a conversion rule', async () => {
  let creates = 0
  const POST = createCatalogConversionsPostHandler({
    authenticate: async () => null,
    createRule: async () => {
      creates += 1
      return sampleRule
    },
  })

  const response = await POST(postRequest({
    sourceUnit: 'length',
    catalogUnit: 'm',
    catalogUnitsPerSourceUnit: '6',
    scope: 'catalog_item',
    catalogId: 'pipe-100',
  }))
  assert.equal(response.status, 401)
  assert.equal(creates, 0)
})

test('POST creates a human-approved rule for an authenticated actor', async () => {
  let seenActor: string | undefined
  const POST = createCatalogConversionsPostHandler({
    authenticate: async () => ({ user: { id: 'admin-1' } }),
    createRule: async (
      input: {
        sourceUnit: string
        catalogUnit: string
        catalogUnitsPerSourceUnit: string
        scope: 'global' | 'catalog_item'
        catalogId?: string
      },
      meta: { actorId: string },
    ) => {
      seenActor = meta.actorId
      return {
        ...sampleRule,
        sourceUnit: input.sourceUnit,
        catalogUnit: input.catalogUnit,
        catalogUnitsPerSourceUnit: input.catalogUnitsPerSourceUnit,
        scope: input.scope,
        catalogId: input.catalogId,
        approvedBy: meta.actorId,
      }
    },
  })

  const response = await POST(postRequest({
    sourceUnit: 'length',
    catalogUnit: 'm',
    catalogUnitsPerSourceUnit: '6',
    scope: 'catalog_item',
    catalogId: 'pipe-100',
  }))
  assert.equal(response.status, 201)
  assert.equal(seenActor, 'admin-1')
  const body = await response.json()
  assert.equal(body.id, 'rule-1')
  assert.equal(body.scope, 'catalog_item')
  assert.equal(body.approvedBy, 'admin-1')
})

test('POST rejects identity scope, unknown keys, and AI-origin fields', async () => {
  let creates = 0
  const POST = createCatalogConversionsPostHandler({
    authenticate: async () => ({ user: { id: 'admin-1' } }),
    createRule: async () => {
      creates += 1
      return sampleRule
    },
  })

  for (const body of [
    {
      sourceUnit: 'm',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '1',
      scope: 'identity',
    },
    {
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      catalogId: 'pipe-100',
      modelVersion: 'gpt-x',
    },
    {
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      catalogId: 'pipe-100',
      origin: 'ai',
    },
    {
      sourceUnit: 'length',
      catalogUnit: 'm',
      catalogUnitsPerSourceUnit: '6',
      scope: 'catalog_item',
      catalogId: 'pipe-100',
      approvedBy: 'forged',
    },
  ]) {
    const response = await POST(postRequest(body))
    assert.equal(response.status, 400, JSON.stringify(body))
    const payload = await response.json()
    assert.match(String(payload.error), /invalid|identity|unexpected|unknown|not allowed/i)
  }
  assert.equal(creates, 0)
})

test('POST maps storage validation errors and keeps auth failures non-leaking', async () => {
  const validationPost = createCatalogConversionsPostHandler({
    authenticate: async () => ({ user: { id: 'admin-1' } }),
    createRule: async () => {
      throw new CatalogConversionStorageError('Conversion factor must be positive.', 400)
    },
  })
  const validationResponse = await validationPost(postRequest({
    sourceUnit: 'length',
    catalogUnit: 'm',
    catalogUnitsPerSourceUnit: '6',
    scope: 'global',
  }))
  assert.equal(validationResponse.status, 400)
  assert.deepEqual(await validationResponse.json(), {
    error: 'Conversion factor must be positive.',
  })

  const authErrorPost = createCatalogConversionsPostHandler({
    authenticate: async () => {
      throw new Error('AUTH_BACKEND: jwt verification failed (PROJECT_ID=buildestimate-prod)')
    },
    createRule: async () => sampleRule,
  })
  const authResponse = await authErrorPost(postRequest({
    sourceUnit: 'length',
    catalogUnit: 'm',
    catalogUnitsPerSourceUnit: '6',
    scope: 'global',
  }))
  assert.equal(authResponse.status, 500)
  const authBody = await authResponse.json()
  assert.deepEqual(authBody, { error: 'Internal server error' })
  assert.doesNotMatch(JSON.stringify(authBody), /AUTH_BACKEND|PROJECT_ID|jwt/)
})

test('DELETE requires authentication before archiving', async () => {
  let archives = 0
  const DELETE = createCatalogConversionsDeleteHandler({
    authenticate: async () => null,
    archiveRule: async () => {
      archives += 1
      return { ...sampleRule, archivedAt: '2026-08-09T00:00:00.000Z' }
    },
  })
  const response = await DELETE(deleteRequest({ id: 'rule-1' }))
  assert.equal(response.status, 401)
  assert.equal(archives, 0)
})

test('DELETE archives a human-approved rule for an authenticated actor', async () => {
  let archivedId: string | undefined
  const DELETE = createCatalogConversionsDeleteHandler({
    authenticate: async () => ({ user: { id: 'admin-2' } }),
    archiveRule: async (id: string) => {
      archivedId = id
      return {
        ...sampleRule,
        id,
        archivedAt: '2026-08-09T00:00:00.000Z',
      }
    },
  })
  const response = await DELETE(deleteRequest({ id: 'rule-1' }))
  assert.equal(response.status, 200)
  assert.equal(archivedId, 'rule-1')
  const body = await response.json()
  assert.equal(body.archivedAt, '2026-08-09T00:00:00.000Z')
})

test('DELETE rejects identity ids and unknown keys', async () => {
  let archives = 0
  const DELETE = createCatalogConversionsDeleteHandler({
    authenticate: async () => ({ user: { id: 'admin-1' } }),
    archiveRule: async () => {
      archives += 1
      return sampleRule
    },
  })

  const identityResponse = await DELETE(deleteRequest({ id: 'identity:m:v1' }))
  assert.equal(identityResponse.status, 400)
  assert.match(String((await identityResponse.json()).error), /identity/i)

  const unknownKeyResponse = await DELETE(deleteRequest({ id: 'rule-1', modelVersion: 'x' }))
  assert.equal(unknownKeyResponse.status, 400)

  assert.equal(archives, 0)
})

test('GET requires authentication and returns rules from storage', async () => {
  const unauth = createCatalogConversionsGetHandler({
    authenticate: async () => null,
    listRules: async () => [sampleRule],
    getRule: async () => sampleRule,
  })
  assert.equal(
    (await unauth(new Request('https://example.test/api/catalog-conversions'))).status,
    401,
  )

  const GET = createCatalogConversionsGetHandler({
    authenticate: async () => ({ user: { id: 'admin-1' } }),
    listRules: async () => [sampleRule],
    getRule: async () => sampleRule,
  })
  const listResponse = await GET(new Request('https://example.test/api/catalog-conversions'))
  assert.equal(listResponse.status, 200)
  assert.deepEqual(await listResponse.json(), { rules: [sampleRule] })

  const oneResponse = await GET(
    new Request('https://example.test/api/catalog-conversions?id=rule-1'),
  )
  assert.equal(oneResponse.status, 200)
  assert.deepEqual(await oneResponse.json(), { rule: sampleRule })
})

test('GET returns 404 when a requested rule is missing', async () => {
  const GET = createCatalogConversionsGetHandler({
    authenticate: async () => ({ user: { id: 'admin-1' } }),
    listRules: async () => [],
    getRule: async () => null,
  })
  const response = await GET(
    new Request('https://example.test/api/catalog-conversions?id=missing'),
  )
  assert.equal(response.status, 404)
})
