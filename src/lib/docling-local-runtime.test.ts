import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('local Docling command and example endpoint use the application default port', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>
  }
  const envExample = readFileSync('.env.example', 'utf8')

  assert.equal(
    packageJson.scripts?.['dev:docling'],
    '.venv-docling/bin/uvicorn --app-dir py-sidecar main:app --host 127.0.0.1 --port 5001',
  )
  assert.match(envExample, /^DOCLING_ENDPOINT=http:\/\/localhost:5001$/m)
})
