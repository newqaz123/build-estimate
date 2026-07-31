import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceUnitError } from '@/lib/units'
import { createWorkspaceUnitsPostHandler } from './handler'

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
