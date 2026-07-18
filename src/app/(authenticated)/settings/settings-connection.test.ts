import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settingsPageSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('Docling connection test uses the authenticated server health proxy', () => {
  assert.match(settingsPageSource, /fetch\("\/api\/docling\/health"/)
  assert.doesNotMatch(settingsPageSource, /fetch\(doclingEndpoint/)
})

test('LLM connection test allows a cold provider request to exceed ten seconds', () => {
  assert.match(settingsPageSource, /const LLM_TEST_TIMEOUT_MS = 30_000/)
  assert.match(settingsPageSource, /setTimeout\(\(\) => controller\.abort\(\), LLM_TEST_TIMEOUT_MS\)/)
})

test('LLM connection test uses the lightweight connection endpoint, not BOQ verification', () => {
  assert.match(settingsPageSource, /fetch\("\/api\/llm\/connection"/)
  assert.doesNotMatch(settingsPageSource, /fetch\("\/api\/llm\/verify"[^\n]*messages/)
})
