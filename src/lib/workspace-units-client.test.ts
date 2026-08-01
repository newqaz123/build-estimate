import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addWorkspaceUnit,
  fetchWorkspaceUnitsOverview,
  loadWorkspaceCustomUnits,
  removeWorkspaceUnit,
  renameWorkspaceUnit,
  WorkspaceUnitInUseError,
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

function fakeFetch(map: Record<string, { status?: number; body: unknown }>) {
  return ((url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`
    const entry = map[key]
    if (!entry) throw new Error(`unexpected ${key}`)
    return Promise.resolve(
      new Response(JSON.stringify(entry.body), {
        status: entry.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as unknown as typeof fetch
}

test('fetchWorkspaceUnitsOverview parses standard/custom/usage', async () => {
  const overview = await fetchWorkspaceUnitsOverview(
    fakeFetch({
      'GET /api/settings/units': {
        body: { standardUnits: ['m³'], customUnits: ['pallet'], usage: { pallet: 2 } },
      },
    }),
  )
  assert.deepEqual(overview, { standardUnits: ['m³'], customUnits: ['pallet'], usage: { pallet: 2 } })
})

test('removeWorkspaceUnit returns the list and surfaces 409 as WorkspaceUnitInUseError', async () => {
  const ok = await removeWorkspaceUnit(
    'crate',
    fakeFetch({ 'DELETE /api/settings/units': { body: { customUnits: ['pallet'] } } }),
  )
  assert.deepEqual(ok.customUnits, ['pallet'])

  await assert.rejects(
    removeWorkspaceUnit(
      'pallet',
      fakeFetch({
        'DELETE /api/settings/units': { status: 409, body: { error: 'in use', usageCount: 4 } },
      }),
    ),
    (err: unknown) => err instanceof WorkspaceUnitInUseError && err.usageCount === 4,
  )
})

test('renameWorkspaceUnit returns the list and updatedItems', async () => {
  const result = await renameWorkspaceUnit(
    'pallet',
    'PLT',
    fakeFetch({
      'PATCH /api/settings/units': {
        body: { customUnits: ['PLT', 'crate'], updatedItems: 2 },
      },
    }),
  )
  assert.deepEqual(result.customUnits, ['PLT', 'crate'])
  assert.equal(result.updatedItems, 2)
})
