import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ESTIMATE_PROMPT,
  buildPromptSavePayload,
  mergePromptSettings,
  promptSettingsAreDirty,
  withPromptDefaults,
} from './prompt-defaults'

test('fills the estimate prompt default without changing existing prompt values', () => {
  const result = withPromptDefaults({
    analysisPrompt: 'analysis',
    stdPrompt: 'standardize',
  })

  assert.equal(result.analysisPrompt, 'analysis')
  assert.equal(result.stdPrompt, 'standardize')
  assert.equal(result.estimatePrompt, DEFAULT_ESTIMATE_PROMPT)
  assert.match(DEFAULT_ESTIMATE_PROMPT, /stdId/)
})

test('updates one prompt field without dropping the other saved prompt fields', () => {
  const saved = withPromptDefaults({
    analysisPrompt: 'analysis',
    stdPrompt: 'standardize',
    estimatePrompt: 'estimate',
  })

  assert.deepEqual(mergePromptSettings(saved, 'estimatePrompt', 'custom estimate'), {
    analysisPrompt: 'analysis',
    stdPrompt: 'standardize',
    estimatePrompt: 'custom estimate',
  })
})

test('marks prompt edits dirty while treating an unchanged prompt set as clean', () => {
  const saved = withPromptDefaults({
    analysisPrompt: 'analysis',
    stdPrompt: 'standardize',
    estimatePrompt: 'estimate',
  })

  assert.equal(promptSettingsAreDirty(saved, saved), false)
  assert.equal(promptSettingsAreDirty({ ...saved, estimatePrompt: 'custom estimate' }, saved), true)
})

test('builds a prompt save payload from saved values and only the selected dirty field', () => {
  const saved = withPromptDefaults({
    analysisPrompt: 'saved analysis',
    stdPrompt: 'saved standardization',
    estimatePrompt: 'saved estimate',
  })
  const current = {
    ...saved,
    analysisPrompt: 'dirty analysis',
    estimatePrompt: 'dirty estimate',
  }

  assert.deepEqual(buildPromptSavePayload(saved, current, 'analysisPrompt'), {
    analysisPrompt: 'dirty analysis',
    stdPrompt: 'saved standardization',
    estimatePrompt: 'saved estimate',
  })
})
