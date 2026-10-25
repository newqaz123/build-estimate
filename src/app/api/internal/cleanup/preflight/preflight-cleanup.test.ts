import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { createPreflightCleanupHandler, preflightCleanupSecretMatches } from '@/app/api/internal/cleanup/preflight/handler'

test('cleanup handler requires secret header', async () => {
  const handler = createPreflightCleanupHandler({
    secret: '',
    cleanup: async () => 0,
  })

  const response = await handler.DELETE(new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
  }))

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
})

test('cleanup handler rejects without secret (fail-closed)', async () => {
  const handler = createPreflightCleanupHandler({
    secret: '',
    cleanup: async () => 0,
  })

  const response = await handler.DELETE(new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
    headers: { 'x-cleanup-secret': 'anything' },
  }))

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
})

test('cleanup handler rejects wrong secret with timing-safe comparison', async () => {
  const handler = createPreflightCleanupHandler({
    secret: 'correct-secret',
    cleanup: async () => 0,
  })

  const response = await handler.DELETE(new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
    headers: { 'x-cleanup-secret': 'wrong-secret' },
  }))

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
})

test('cleanup handler accepts correct secret and runs cleanup', async () => {
  let ran = false
  const handler = createPreflightCleanupHandler({
    secret: 'test-secret',
    cleanup: async () => {
      ran = true
      return 5
    },
  })

  const response = await handler.DELETE(new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
    headers: { 'x-cleanup-secret': 'test-secret' },
  }))

  assert.equal(ran, true)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { deleted: 5 })
})

test('cleanup handler returns 500 on cleanup error', async (t) => {
  const handler = createPreflightCleanupHandler({
    secret: 'test-secret',
    cleanup: async () => {
      throw new Error('Database error')
    },
  })

  t.mock.method(console, 'error', () => {})

  const response = await handler.DELETE(new Request('http://localhost/api/internal/cleanup/preflight', {
    method: 'DELETE',
    headers: { 'x-cleanup-secret': 'test-secret' },
  }))

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'Internal server error' })
})

test('preflightCleanupSecretMatches uses timing-safe comparison', async () => {
  assert.equal(preflightCleanupSecretMatches('secret', 'secret'), true)
  assert.equal(preflightCleanupSecretMatches('secret', 'wrong'), false)
  assert.equal(preflightCleanupSecretMatches('', ''), false, 'an empty secret never matches')
  assert.equal(preflightCleanupSecretMatches('a', 'b'), false)
})

test('timing-safe comparison prevents timing attacks', async () => {
  const secret = randomBytes(32).toString('hex')
  const wrong = randomBytes(32).toString('hex')

  assert.equal(preflightCleanupSecretMatches(secret, secret), true)
  assert.equal(preflightCleanupSecretMatches(secret, wrong), false)
})

const URL_ = 'http://localhost/api/internal/cleanup/preflight'
function cronHandler(cronSecret: string, calls: { n: number }) {
  return createPreflightCleanupHandler({ secret: '', cronSecret, cleanup: async () => { calls.n += 1; return 3 } })
}

test('cron GET with the right CRON_SECRET bearer runs the cleanup', async () => {
  const calls = { n: 0 }
  const response = await cronHandler('cron-secret-value', calls).GET(new Request(URL_, { headers: { authorization: 'Bearer cron-secret-value' } }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { deleted: 3 })
  assert.equal(calls.n, 1)
})

test('cron refuses a wrong, missing or malformed bearer, and refuses everything when CRON_SECRET is unset', async () => {
  const calls = { n: 0 }
  const handler = cronHandler('cron-secret-value', calls)
  for (const headers of [
    { authorization: 'Bearer wrong' },
    { authorization: 'Bearer cron-secret-valu' },
    { authorization: 'cron-secret-value' },
    {},
    { 'x-cleanup-secret': 'cron-secret-value' },
  ] as Array<Record<string, string>>) {
    assert.equal((await handler.GET(new Request(URL_, { headers }))).status, 401)
  }
  const unset = cronHandler('', calls)
  assert.equal((await unset.GET(new Request(URL_, { headers: { authorization: 'Bearer ' } }))).status, 401)
  assert.equal((await unset.GET(new Request(URL_, { headers: { authorization: 'Bearer anything' } }))).status, 401)
  assert.equal((await unset.DELETE(new Request(URL_, { method: 'DELETE', headers: { authorization: 'Bearer anything' } }))).status, 401)
  assert.equal(calls.n, 0)
})

test('the CRON_SECRET bearer and the ops header secret are separate', async () => {
  const calls = { n: 0 }
  const handler = createPreflightCleanupHandler({ secret: 'ops-secret', cronSecret: 'cron-secret', cleanup: async () => { calls.n += 1; return 0 } })
  assert.equal((await handler.DELETE(new Request(URL_, { method: 'DELETE', headers: { authorization: 'Bearer ops-secret' } }))).status, 401)
  assert.equal((await handler.DELETE(new Request(URL_, { method: 'DELETE', headers: { 'x-cleanup-secret': 'cron-secret' } }))).status, 401)
  assert.equal((await handler.DELETE(new Request(URL_, { method: 'DELETE', headers: { authorization: 'Bearer cron-secret' } }))).status, 200)
  assert.equal((await handler.DELETE(new Request(URL_, { method: 'DELETE', headers: { 'x-cleanup-secret': 'ops-secret' } }))).status, 200)
  assert.equal(calls.n, 2)
})

test('secret comparison is constant-time over hashed values and never matches an empty secret', () => {
  assert.equal(preflightCleanupSecretMatches('', ''), false)
  assert.equal(preflightCleanupSecretMatches('abc', 'abc'), true)
  assert.equal(preflightCleanupSecretMatches('abc', 'abcd'), false)
  const source = readFileSync(new URL('./handler.ts', import.meta.url), 'utf8')
  assert.match(source, /timingSafeEqual\(expectedDigest, actualDigest\)/)
  assert.doesNotMatch(source, /expected === actual|=== secret/)
  const route = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')
  assert.match(route, /cronSecret: process\.env\.CRON_SECRET \?\? ''/)
  assert.match(route, /export const \{ GET, DELETE \}/)
})

test('.env.example documents CRON_SECRET for the cleanup cron', () => {
  const env = readFileSync(new URL('../../../../../../.env.example', import.meta.url), 'utf8')
  assert.match(env, /^CRON_SECRET=$/m)
  assert.match(env, /Authorization: Bearer/)
})
