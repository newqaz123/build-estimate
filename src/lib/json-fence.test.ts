import assert from 'node:assert/strict'
import test from 'node:test'
import { unwrapConventionalJsonFence } from './json-fence'
import { normalizeAiVerification } from './boq-verification'

test('unwrapConventionalJsonFence strips a single json fence and trims plain text', () => {
  assert.equal(unwrapConventionalJsonFence('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(unwrapConventionalJsonFence('```\n{"a":1}\n```'), '{"a":1}')
  assert.equal(unwrapConventionalJsonFence('  {"a":1}  '), '{"a":1}')
  assert.equal(unwrapConventionalJsonFence('text ```json {"a":1}```'), 'text ```json {"a":1}```')
})

test('AI verification accepts fenced JSON from models that ignore JSON mode', () => {
  assert.deepEqual(normalizeAiVerification('```json\n{"issues":[]}\n```'), [])
  assert.throws(() => normalizeAiVerification('Sure! {"issues":[]}'))
})
