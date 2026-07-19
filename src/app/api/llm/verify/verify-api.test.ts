import assert from 'node:assert/strict'
import test from 'node:test'
import { executeVerification, type VerifyApiDependencies } from './verify-api'

const request = {
  boqId: 'boq-1',
  vendor: 'Eastern Group',
  project: 'Pipe installation',
  workType: 'MEP',
  date: '2026-06-11',
  items: [{ id: 'item-1', desc: 'Pipe 1B', unit: 'Pcs.', qty: 3, rate: 1781, total: 5343 }],
  extractionWarnings: [],
  sourceTotal: 5343,
}

function dependencies(overrides: Partial<VerifyApiDependencies> = {}): VerifyApiDependencies {
  return {
    getSettings: async () => null,
    env: { OPENAI_API_KEY: 'secret' },
    timeoutMs: 50,
    callProvider: async (_messages, provider, model) => ({
      content: '{"issues":[]}', provider, model,
    }),
    ...overrides,
  }
}

test('provider deadline aborts the real call path and returns an HTTP-200 local timeout', async () => {
  let receivedSignal: AbortSignal | undefined
  const result = await executeVerification(request, dependencies({
    timeoutMs: 5,
    callProvider: async (_messages, _provider, _model, signal) => {
      receivedSignal = signal
      return await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true })
      })
    },
  }))
  assert.equal(receivedSignal?.aborted, true)
  assert.equal(result.status, 200)
  assert.equal(result.body.mode, 'local')
  assert.equal(result.body.aiStatus, 'timeout')
})

test('provider 401 becomes local unauthorized and settings failure safely uses environment defaults', async () => {
  const unauthorized = await executeVerification(request, dependencies({
    callProvider: async () => { throw Object.assign(new Error('upstream rejected'), { status: 401 }) },
  }))
  assert.equal(unauthorized.status, 200)
  assert.equal(unauthorized.body.mode, 'local')
  assert.equal(unauthorized.body.aiStatus, 'unauthorized')

  const settingsFailure = await executeVerification(request, dependencies({
    getSettings: async () => { throw new Error('private database details') },
  }))
  assert.equal(settingsFailure.status, 200)
  assert.equal(settingsFailure.body.mode, 'ai')
})

test('oversize structured request returns safe 400 without calling settings or provider', async () => {
  let settingsCalls = 0
  let providerCalls = 0
  const result = await executeVerification({
    ...request,
    items: Array.from({ length: 501 }, (_, index) => ({ ...request.items[0], id: `item-${index}` })),
  }, dependencies({
    getSettings: async () => { settingsCalls += 1; return null },
    callProvider: async () => { providerCalls += 1; throw new Error('must not run') },
  }))
  assert.equal(result.status, 400)
  assert.deepEqual(result.body, { error: 'items must be an array with at most 500 entries' })
  assert.equal(settingsCalls, 0)
  assert.equal(providerCalls, 0)
})

test('excluded options survive the review verification contract without creating total mismatches', async () => {
  let providerMessages: { role: string; content: string }[] = []
  const result = await executeVerification({
    ...request,
    sourceTotal: 95_200,
    items: [
      { id: 'bundle', desc: 'Pump package', unit: 'item', qty: 1, rate: 95_200, total: 95_200 },
      { id: 'option', desc: 'Optional controls', unit: 'item', qty: 1, rate: 10_000, total: 10_000, optional: true, excludedFromTotal: true },
    ],
  }, dependencies({
    callProvider: async (messages, provider, model) => {
      providerMessages = messages
      return { content: '{"issues":[]}', provider, model }
    },
  }))

  assert.equal(result.status, 200)
  assert.equal('issues' in result.body && result.body.issues.some((issue) => issue.code === 'document_total_mismatch'), false)
  assert.match(providerMessages[0]?.content ?? '', /excludedFromTotal[\s\S]*do not[\s\S]*total mismatch/i)
  assert.match(providerMessages[1]?.content ?? '', /"excludedFromTotal":true/)
})
