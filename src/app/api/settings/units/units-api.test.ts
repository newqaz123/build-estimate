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

test('maps validation and cap failures without leaking infrastructure details', async () => {
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
    assert.equal((await POST(request({ unit: 'bag' }))).status, status)
  }
})
