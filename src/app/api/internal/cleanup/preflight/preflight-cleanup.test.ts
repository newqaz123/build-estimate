import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'

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
  assert.equal(preflightCleanupSecretMatches('', ''), true)
  assert.equal(preflightCleanupSecretMatches('a', 'b'), false)
})

test('timing-safe comparison prevents timing attacks', async () => {
  const secret = randomBytes(32).toString('hex')
  const wrong = randomBytes(32).toString('hex')

  assert.equal(preflightCleanupSecretMatches(secret, secret), true)
  assert.equal(preflightCleanupSecretMatches(secret, wrong), false)
})
