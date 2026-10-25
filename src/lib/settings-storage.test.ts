import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  decodeNormalizeRules,
  effectiveLlmSettings,
  fromStoredSettings,
  toStoredSettings,
} from './settings-storage'

const defaults: [string, string][] = [['default', 'replacement']]

test('decodes legacy tuples and stored rule records while filtering malformed entries', () => {
  assert.deepEqual(
    decodeNormalizeRules([
      ['legacy', 'tuple'],
      { find: 'stored', replace: 'record' },
      ['missing replacement'],
      { find: 'missing replacement' },
      null,
    ], defaults),
    [
      ['legacy', 'tuple'],
      ['stored', 'record'],
    ],
  )
})

test('uses safe defaults when storage contains no valid rules', () => {
  assert.deepEqual(decodeNormalizeRules([null, ['bad']], defaults), defaults)
  const decoded = decodeNormalizeRules(undefined, defaults)
  assert.deepEqual(decoded, defaults)

  decoded[0][0] = 'mutated'
  assert.deepEqual(defaults, [['default', 'replacement']])
})

test('preserves an intentionally empty stored rules list', () => {
  assert.deepEqual(decodeNormalizeRules([], defaults), [])
})

test('older workspace settings default to an empty custom-unit list', () => {
  const decoded = fromStoredSettings({
    llm: DEFAULT_SETTINGS.llm,
    docling: DEFAULT_SETTINGS.docling,
    fuzzy: {
      unitMap: {},
      normalizeRules: [],
    },
    prompts: DEFAULT_SETTINGS.prompts,
  })

  assert.deepEqual(decoded.units, { customUnits: [] })
})

test('stored custom units are sanitized without changing their first casing or order', () => {
  const decoded = fromStoredSettings({
    units: { customUnits: [' Bag ', 'bag', 'drum', 'bad\u0000unit'] },
  })

  assert.deepEqual(decoded.units.customUnits, ['Bag', 'drum'])
  assert.deepEqual(
    toStoredSettings(decoded).units,
    { customUnits: ['Bag', 'drum'] },
  )
})

test('toStoredSettings normalizes dirty custom units before serialization', () => {
  const stored = toStoredSettings({
    ...DEFAULT_SETTINGS,
    units: {
      customUnits: [' Bag ', 'bag', 'drum', 'bad\u0000unit', 'x'.repeat(25)],
    },
  })

  assert.deepEqual(stored.units, { customUnits: ['Bag', 'drum'] })
})

test('defaults actionable review to off for existing settings documents', () => {
  const settings = fromStoredSettings({})
  assert.equal(settings.actionableReview.stage, 'off')
  assert.equal(settings.actionableReview.maxRows, 100)
  assert.equal(settings.actionableReview.escalationEnabled, true)
  assert.equal(settings.actionableReview.maxPromptTokens, 8_000)
  assert.equal(settings.actionableReview.maxEstimatedCostMinor, 0)
})

test('rejects unknown stages and negative budgets', () => {
  assert.throws(() => fromStoredSettings({
    actionableReview: {
      stage: 'automatic',
      maxRows: -1,
      maxPromptTokens: 0,
      maxEstimatedCostMinor: -1,
      escalationEnabled: true,
    },
  }))
})

test('effective LLM settings: saved choice wins, otherwise the server env, otherwise the default', () => {
  assert.deepEqual(effectiveLlmSettings({ provider: 'openai', model: 'gpt-4o-mini' }, { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'x/y' }), { provider: 'openai', model: 'gpt-4o-mini' })
  assert.deepEqual(effectiveLlmSettings(undefined, { LLM_PROVIDER: 'OpenRouter ', LLM_MODEL: ' vendor/model-1 ' }), { provider: 'openrouter', model: 'vendor/model-1' })
  assert.deepEqual(effectiveLlmSettings(null, { LLM_PROVIDER: 'openrouter' }), { provider: 'openrouter', model: 'openai/gpt-4o' })
  assert.deepEqual(effectiveLlmSettings(undefined, { LLM_PROVIDER: 'nope' }), DEFAULT_SETTINGS.llm)
  assert.deepEqual(effectiveLlmSettings(undefined, {}), DEFAULT_SETTINGS.llm)
})
