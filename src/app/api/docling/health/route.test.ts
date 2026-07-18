import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const routePath = fileURLToPath(new URL('./route.ts', import.meta.url))

test('Docling health proxy validates the endpoint and calls its GET health route', () => {
  assert.equal(existsSync(routePath), true, 'health proxy route is required')

  const source = readFileSync(routePath, 'utf8')
  assert.match(source, /buildDoclingHealthUrl/)
  assert.match(source, /method: 'GET'/)
})
