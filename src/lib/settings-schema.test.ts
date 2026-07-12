import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ESTIMATE_PROMPT, withPromptDefaults } from './prompt-defaults'

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
