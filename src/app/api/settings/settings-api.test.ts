import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { validateSettingsSection } from './route'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')
const getSource = source.slice(
  source.indexOf('export async function GET'),
  source.indexOf('export async function PUT'),
)

test('settings GET returns defaults (with the effective server LLM) without writing a missing document', () => {
  assert.match(getSource, /existing \? fromStoredSettings\(existing\) : DEFAULT_SETTINGS/)
  assert.match(getSource, /llm: effectiveLlmSettings\(existing\?\.llm, process\.env\)/)
  assert.doesNotMatch(getSource, /setDocument/)
})

test('PUT accepts closed actionable review fields and rejects extras', () => {
  const accepted = validateSettingsSection('actionableReview', {
    stage: 'shadow',
    maxRows: 50,
    maxPromptTokens: 4_000,
    maxEstimatedCostMinor: 25,
    escalationEnabled: false,
    lowCostModel: 'gpt-4o-mini',
    escalationModel: 'gpt-4o',
  })
  assert.equal(accepted.valid, true)
  if (accepted.valid) {
    assert.deepEqual(accepted.data, {
      stage: 'shadow',
      maxRows: 50,
      maxPromptTokens: 4_000,
      maxEstimatedCostMinor: 25,
      escalationEnabled: false,
      lowCostModel: 'gpt-4o-mini',
      escalationModel: 'gpt-4o',
    })
  }

  const rejected = validateSettingsSection('actionableReview', {
    stage: 'shadow',
    maxRows: 50,
    maxPromptTokens: 4_000,
    maxEstimatedCostMinor: 25,
    escalationEnabled: false,
    autoAdd: true,
  })
  assert.equal(rejected.valid, false)
})

test('PUT llm only accepts providers the server can call', () => {
  assert.equal(validateSettingsSection('llm', { provider: 'openrouter', model: 'vendor/model' }).valid, true)
  assert.equal(validateSettingsSection('llm', { provider: 'openai', model: 'gpt-4o' }).valid, true)
  assert.equal(validateSettingsSection('llm', { provider: 'anthropic', model: 'claude' }).valid, false)
  assert.equal(validateSettingsSection('llm', { provider: 'google', model: 'gemini' }).valid, false)
})
