import assert from 'node:assert/strict'
import test from 'node:test'
import { executeLlmConnection } from './llm-connection'

test('LLM connection check accepts provider settings without a BOQ payload', async () => {
  const result = await executeLlmConnection(
    { provider: 'openai', model: 'gpt-4o' },
    {
      env: { OPENAI_API_KEY: 'test-key' },
      callProvider: async (messages, provider, model) => {
        assert.deepEqual(messages, [{ role: 'user', content: 'Reply with OK.' }])
        return { content: 'OK', provider, model }
      },
      timeoutMs: 100,
    },
  )
  assert.deepEqual(result, { status: 200, body: { provider: 'openai', model: 'gpt-4o' } })
})

test('LLM connection check reports missing provider credentials', async () => {
  const result = await executeLlmConnection(
    { provider: 'openai', model: 'gpt-4o' },
    { env: {}, callProvider: async () => { throw new Error('must not call provider') }, timeoutMs: 100 },
  )
  assert.deepEqual(result, { status: 503, body: { error: 'OpenAI API key is not configured' } })
})
