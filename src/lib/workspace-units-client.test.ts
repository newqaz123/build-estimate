import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addWorkspaceUnit,
  loadWorkspaceCustomUnits,
} from './workspace-units-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('loads custom units while accepting legacy settings without a units section', async () => {
  const fetchImpl = (async () => jsonResponse({
    llm: { provider: 'openai', model: 'gpt-4o' },
  })) as typeof fetch

  assert.deepEqual(
    await loadWorkspaceCustomUnits(fetchImpl),
    [],
  )
})

test('loads a valid non-empty workspace unit list', async () => {
  const fetchImpl = (async () => jsonResponse({
    units: { customUnits: ['bag', 'drum'] },
  })) as typeof fetch

  assert.deepEqual(
    await loadWorkspaceCustomUnits(fetchImpl),
    ['bag', 'drum'],
  )
})

test('throws a readable error for failed or malformed settings responses', async () => {
  const failedFetch = (async () => jsonResponse(
    { error: 'Settings unavailable.' },
    503,
  )) as typeof fetch
  await assert.rejects(
    loadWorkspaceCustomUnits(failedFetch),
    /Settings unavailable\./,
  )

  const malformedFetch = (async () => jsonResponse({
    units: { customUnits: 'bag' },
  })) as typeof fetch
  await assert.rejects(
    loadWorkspaceCustomUnits(malformedFetch),
    /Workspace units returned an invalid response\./,
  )
})

test('posts one unit and validates the canonical response', async () => {
  let receivedUrl = ''
  let receivedInit: RequestInit | undefined
  const fetchImpl = (async (input, init) => {
    receivedUrl = String(input)
    receivedInit = init
    return jsonResponse({ unit: 'Bag', customUnits: ['Bag'] })
  }) as typeof fetch

  assert.deepEqual(await addWorkspaceUnit('bag', fetchImpl), {
    unit: 'Bag',
    customUnits: ['Bag'],
  })
  assert.equal(receivedUrl, '/api/settings/units')
  assert.equal(receivedInit?.method, 'POST')
  assert.equal(
    receivedInit?.body,
    JSON.stringify({ unit: 'bag' }),
  )
})

test('preserves the server error message for an add failure', async () => {
  const fetchImpl = (async () => jsonResponse(
    { error: 'Workspace unit limit reached.' },
    409,
  )) as typeof fetch

  await assert.rejects(
    addWorkspaceUnit('bag', fetchImpl),
    /Workspace unit limit reached\./,
  )
})

test('rejects a malformed successful add response', async () => {
  // A 200 response missing the canonical unit must not be trusted.
  const missingUnit = (async () => jsonResponse({
    customUnits: ['bag'],
  })) as typeof fetch
  await assert.rejects(
    addWorkspaceUnit('bag', missingUnit),
    /Workspace units returned an invalid response\./,
  )

  // A 200 response missing the updated custom-unit list is equally invalid.
  const missingUnits = (async () => jsonResponse({
    unit: 'bag',
  })) as typeof fetch
  await assert.rejects(
    addWorkspaceUnit('bag', missingUnits),
    /Workspace units returned an invalid response\./,
  )
})
