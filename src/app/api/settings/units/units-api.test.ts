import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceUnitError } from '@/lib/units'
import {
  createWorkspaceUnitsPostHandler,
  createWorkspaceUnitsGetHandler,
  createWorkspaceUnitsDeleteHandler,
  createWorkspaceUnitsPatchHandler,
} from './handler'

function request(body: unknown) {
  return new Request('https://example.test/api/settings/units', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('requires authentication before accepting a unit', async () => {
  let additions = 0
  const POST = createWorkspaceUnitsPostHandler({
    authenticate: async () => null,
    addUnit: async () => {
      additions += 1
      return { unit: 'bag', customUnits: ['bag'], added: true }
    },
  })

  const response = await POST(request({ unit: 'bag' }))
  assert.equal(response.status, 401)
  assert.equal(additions, 0)
})

test('returns the canonical unit and updated list for success and duplicate requests', async () => {
  const POST = createWorkspaceUnitsPostHandler({
    authenticate: async () => ({ user: {} }),
    addUnit: async () => ({
      unit: 'Bag',
      customUnits: ['Bag'],
      added: false,
    }),
  })

  const response = await POST(request({ unit: 'bag' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    unit: 'Bag',
    customUnits: ['Bag'],
  })
})

test('maps validation and cap failures to readable, non-leaking error bodies', async () => {
  for (const [error, status] of [
    [new WorkspaceUnitError('Unit is required.', 400), 400],
    [new WorkspaceUnitError('Workspace unit limit reached.', 409), 409],
  ] as const) {
    const POST = createWorkspaceUnitsPostHandler({
      authenticate: async () => ({ user: {} }),
      addUnit: async () => {
        throw error
      },
    })
    const response = await POST(request({ unit: 'bag' }))
    assert.equal(response.status, status)
    // The readable domain message is preserved verbatim for the client.
    assert.deepEqual(await response.json(), { error: error.message })
  }
})

test('returns a generic non-leaking 500 when the auth backend rejects', async () => {
  // An authentication backend rejection (e.g. a Firestore/JWT error) must not
  // propagate or leak infrastructure details; the normal unauthenticated result
  // stays a 401.
  const authError = new Error(
    'AUTH_BACKEND: jwt verification failed (PROJECT_ID=buildestimate-prod)',
  )
  const POST = createWorkspaceUnitsPostHandler({
    authenticate: async () => {
      throw authError
    },
    addUnit: async () => ({ unit: 'bag', customUnits: ['bag'], added: true }),
  })

  const response = await POST(request({ unit: 'bag' }))
  assert.equal(response.status, 500)
  const body = await response.json()
  assert.deepEqual(body, { error: 'Internal server error' })
  assert.doesNotMatch(JSON.stringify(body), /AUTH_BACKEND|PROJECT_ID|jwt/)
})

test('maps a non-validation error from storage to a generic 500', async () => {
  const POST = createWorkspaceUnitsPostHandler({
    authenticate: async () => ({ user: {} }),
    addUnit: async () => {
      throw new SyntaxError('unexpected token in storage payload')
    },
  })

  const response = await POST(request({ unit: 'bag' }))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Internal server error' })
})

const okAuth = async () => ({ user: { id: '1' } })
const noAuth = async () => null

test('GET returns standard + custom units and per-custom usage', async () => {
  const GET = createWorkspaceUnitsGetHandler({
    authenticate: okAuth,
    readSettings: async () => ({ units: { customUnits: ['pallet', 'crate'] } }),
    readAllBoqs: async () => [
      { id: 'b1', data: { sections: [{ items: [{ pricingRole: 'standard', unit: 'pallet' }] }] } },
    ],
  })
  const res = await GET(new Request('http://x/api/settings/units'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.standardUnits.includes('m³'))
  assert.deepEqual(body.customUnits, ['pallet', 'crate'])
  assert.deepEqual(body.usage, { pallet: 1, crate: 0 })
})

test('GET rejects unauthenticated with 401', async () => {
  const GET = createWorkspaceUnitsGetHandler({
    authenticate: noAuth,
    readSettings: async () => null,
    readAllBoqs: async () => [],
  })
  const res = await GET(new Request('http://x/api/settings/units'))
  assert.equal(res.status, 401)
})

test('DELETE returns 409 with usageCount when the unit is in use', async () => {
  const DELETE = createWorkspaceUnitsDeleteHandler({
    authenticate: okAuth,
    countUsage: async () => 3,
    removeUnit: async () => ({ customUnits: [] }),
  })
  const res = await DELETE(
    new Request('http://x/api/settings/units', {
      method: 'DELETE',
      body: JSON.stringify({ unit: 'pallet' }),
    }),
  )
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.usageCount, 3)
})

test('DELETE removes and returns the custom list when not in use', async () => {
  let removed: string | null = null
  const DELETE = createWorkspaceUnitsDeleteHandler({
    authenticate: okAuth,
    countUsage: async () => 0,
    removeUnit: async (unit: string) => {
      removed = unit
      return { customUnits: ['crate'] }
    },
  })
  const res = await DELETE(
    new Request('http://x/api/settings/units', {
      method: 'DELETE',
      body: JSON.stringify({ unit: 'pallet' }),
    }),
  )
  assert.equal(res.status, 200)
  assert.equal(removed, 'pallet')
  assert.deepEqual((await res.json()).customUnits, ['crate'])
})

test('DELETE rejects malformed body with 400 and unauthenticated with 401', async () => {
  const DELETE = createWorkspaceUnitsDeleteHandler({
    authenticate: okAuth,
    countUsage: async () => 0,
    removeUnit: async () => ({ customUnits: [] }),
  })
  const bad = await DELETE(
    new Request('http://x/api/settings/units', { method: 'DELETE', body: '{}' }),
  )
  assert.equal(bad.status, 400)
  const unauth = createWorkspaceUnitsDeleteHandler({
    authenticate: noAuth,
    countUsage: async () => 0,
    removeUnit: async () => ({ customUnits: [] }),
  })
  assert.equal(
    (await unauth(
      new Request('http://x/api/settings/units', {
        method: 'DELETE',
        body: JSON.stringify({ unit: 'x' }),
      }),
    )).status,
    401,
  )
})

test('PATCH renames and returns the list plus updatedItems', async () => {
  const PATCH = createWorkspaceUnitsPatchHandler({
    authenticate: okAuth,
    renameUnit: async () => ({ customUnits: ['PLT', 'crate'], updatedBoqs: 1, updatedItems: 2 }),
  })
  const res = await PATCH(
    new Request('http://x/api/settings/units', {
      method: 'PATCH',
      body: JSON.stringify({ oldUnit: 'pallet', newUnit: 'PLT' }),
    }),
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.customUnits, ['PLT', 'crate'])
  assert.equal(body.updatedItems, 2)
})

test('PATCH surfaces a 409 WorkspaceUnitError and rejects malformed body with 400', async () => {
  const { WorkspaceUnitError } = await import('@/lib/units')
  const PATCH = createWorkspaceUnitsPatchHandler({
    authenticate: okAuth,
    renameUnit: async () => {
      throw new WorkspaceUnitError('Unit is not a custom unit.', 404)
    },
  })
  const conflict = await PATCH(
    new Request('http://x/api/settings/units', {
      method: 'PATCH',
      body: JSON.stringify({ oldUnit: 'pallet', newUnit: 'PLT' }),
    }),
  )
  assert.equal(conflict.status, 404)
  const malformed = await PATCH(
    new Request('http://x/api/settings/units', { method: 'PATCH', body: JSON.stringify({}) }),
  )
  assert.equal(malformed.status, 400)
})
