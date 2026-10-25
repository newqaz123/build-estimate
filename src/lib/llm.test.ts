import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callLLM,
  createActionableReviewProviderCall,
  DEFAULT_LLM_MAX_TOKENS,
  openRouterReasoning,
  type LlmCallOptions,
  type LlmUsageLogEntry,
} from './llm'

type Captured = { url: string; init: RequestInit; body: Record<string, unknown> }

function mockFetch(
  responder: (captured: Captured) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const captured = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) }
    calls.push(captured)
    return responder(captured)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const completion = (content: string, usage?: Record<string, number>) => ({
  choices: [{ message: { role: 'assistant', content } }],
  ...(usage ? { usage } : {}),
})

function opts(extra: Partial<LlmCallOptions> & Pick<LlmCallOptions, 'fetchImpl'>): LlmCallOptions {
  return { env: { OPENAI_API_KEY: 'sk-test', OPENROUTER_API_KEY: 'sk-or-test' }, logUsage: () => {}, ...extra }
}

const messages = [{ role: 'user', content: 'hello' }]

test('callLLM sends a bearer key, default max_tokens and an abort signal to OpenAI', async () => {
  const { fetchImpl, calls } = mockFetch(() => okJson(completion('hi')))
  const result = await callLLM(messages, 'openai', 'gpt-4o-mini', undefined, opts({ fetchImpl }))
  assert.equal(result.content, 'hi')
  assert.equal(result.provider, 'openai')
  assert.equal(result.model, 'gpt-4o-mini')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sk-test')
  assert.equal(calls[0]!.body.max_tokens, DEFAULT_LLM_MAX_TOKENS)
  assert.equal(calls[0]!.body.response_format, undefined)
  assert.ok(calls[0]!.init.signal instanceof AbortSignal)
})

test('callLLM routes to OpenRouter with its own key and default model', async () => {
  const { fetchImpl, calls } = mockFetch(() => okJson(completion('ok')))
  const result = await callLLM(messages, 'openrouter', undefined, undefined, opts({ fetchImpl, env: { OPENROUTER_API_KEY: 'sk-or-test' } }))
  assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sk-or-test')
  assert.equal(result.model, 'openai/gpt-4o')
})

test('callLLM fails clearly without calling fetch when the API key is missing or blank', async () => {
  const { fetchImpl, calls } = mockFetch(() => okJson(completion('never')))
  await assert.rejects(
    callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl, env: {} })),
    /OpenAI API key is not configured \(OPENAI_API_KEY\)/,
  )
  await assert.rejects(
    callLLM(messages, 'openrouter', undefined, undefined, opts({ fetchImpl, env: { OPENROUTER_API_KEY: '   ' } })),
    /OpenRouter API key is not configured/,
  )
  assert.equal(calls.length, 0, 'must never send "Bearer undefined"')
})

test('callLLM rejects unsupported providers', async () => {
  const { fetchImpl, calls } = mockFetch(() => okJson(completion('never')))
  await assert.rejects(callLLM(messages, 'evil', undefined, undefined, opts({ fetchImpl })), /Unsupported LLM provider: evil/)
  assert.equal(calls.length, 0)
})

test('callLLM honours maxTokens and json response format', async () => {
  const { fetchImpl, calls } = mockFetch(() => okJson(completion('{"a":1}')))
  await callLLM([{ role: 'user', content: 'Return JSON please' }], 'openai', undefined, undefined, opts({ fetchImpl, maxTokens: 123, responseFormat: 'json' }))
  assert.equal(calls[0]!.body.max_tokens, 123)
  assert.deepEqual(calls[0]!.body.response_format, { type: 'json_object' })
  assert.equal((calls[0]!.body.messages as unknown[]).length, 1, 'prompt already mentions JSON')
})

test('callLLM adds a JSON instruction when json mode is requested but no message mentions it', async () => {
  const { fetchImpl, calls } = mockFetch(() => okJson(completion('{}')))
  await callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl, responseFormat: 'json' }))
  const sent = calls[0]!.body.messages as { role: string; content: string }[]
  assert.equal(sent.length, 2)
  assert.equal(sent[0]!.role, 'system')
  assert.match(sent[0]!.content, /JSON/)
})

test('callLLM throws a clear error when choices is empty or missing', async () => {
  for (const data of [{ choices: [] }, {}, { choices: null }, { choices: [{}] }, { choices: [{ message: { content: null } }] }, null]) {
    const { fetchImpl } = mockFetch(() => okJson(data))
    await assert.rejects(
      callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl })),
      /OpenAI API returned (no choices|a choice without text content)/,
      `payload ${JSON.stringify(data)}`,
    )
  }
})

test('callLLM reports HTTP errors and non-JSON bodies clearly', async () => {
  const failing = mockFetch(() => new Response('nope', { status: 429, statusText: 'Too Many Requests' }))
  await assert.rejects(callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl: failing.fetchImpl })), /OpenAI API error: 429 Too Many Requests/)
  const html = mockFetch(() => new Response('<html>', { status: 200 }))
  await assert.rejects(callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl: html.fetchImpl })), /non-JSON response/)
})

test('callLLM times out via AbortSignal with a clear message', async () => {
  const { fetchImpl } = mockFetch(({ init }) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
  }))
  await assert.rejects(
    callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl, timeoutMs: 20 })),
    /OpenAI API request timed out after 20ms/,
  )
})

test('callLLM still honours a caller-supplied abort signal', async () => {
  const controller = new AbortController()
  const { fetchImpl } = mockFetch(({ init }) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('caller aborted')))
  }))
  const pending = callLLM(messages, 'openai', undefined, controller.signal, opts({ fetchImpl, timeoutMs: 10_000 }))
  controller.abort()
  await assert.rejects(pending, /caller aborted/)
})

test('callLLM logs and returns token usage', async () => {
  const logged: LlmUsageLogEntry[] = []
  const { fetchImpl } = mockFetch(() => okJson(completion('hi', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })))
  const result = await callLLM(messages, 'openai', 'gpt-4o', undefined, opts({ fetchImpl, logUsage: (entry) => logged.push(entry) }))
  assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 })
  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.provider, 'openai')
  assert.equal(logged[0]!.model, 'gpt-4o')
  assert.equal(logged[0]!.totalTokens, 18)
  assert.ok(logged[0]!.durationMs >= 0)
})

test('callLLM logs usage even when the provider omits it', async () => {
  const logged: LlmUsageLogEntry[] = []
  const { fetchImpl } = mockFetch(() => okJson(completion('hi')))
  const result = await callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl, logUsage: (entry) => logged.push(entry) }))
  assert.equal(result.usage, undefined)
  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.totalTokens, undefined)
})

test('createActionableReviewProviderCall requests JSON response format', async () => {
  let seenOptions: LlmCallOptions | undefined
  const call = createActionableReviewProviderCall({
    callLLM: async (_messages, provider, model, _signal, options) => {
      seenOptions = options
      return { content: '{"advice":[]}', provider: provider ?? 'openai', model: model ?? 'm' }
    },
  })
  assert.deepEqual(await call({ model: 'm', rows: [], maxPromptTokens: 100 }), { advice: [] })
  assert.equal(seenOptions?.responseFormat, 'json')
})

test('callLLM retries once without response_format when the model rejects JSON mode', async () => {
  const { fetchImpl, calls } = mockFetch((captured) => captured.body.response_format
    ? new Response('{"error":"response_format not supported"}', { status: 400, statusText: 'Bad Request' })
    : okJson(completion('```json\n{"ok":true}\n```')))
  const result = await callLLM(messages, 'openrouter', 'some/model', undefined, opts({ fetchImpl, responseFormat: 'json' }))
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0]!.body.response_format, { type: 'json_object' })
  assert.equal('response_format' in calls[1]!.body, false)
  // The plain retry still asks for JSON in the messages.
  assert.match(JSON.stringify(calls[1]!.body.messages), /JSON/)
  assert.match(result.content, /"ok":true/)
})

test('callLLM does not retry non-JSON-mode failures or non-400 errors', async () => {
  const plain = mockFetch(() => new Response('bad', { status: 400, statusText: 'Bad Request' }))
  await assert.rejects(callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl: plain.fetchImpl })), /400/)
  assert.equal(plain.calls.length, 1)
  const server = mockFetch(() => new Response('down', { status: 503, statusText: 'Unavailable' }))
  await assert.rejects(callLLM(messages, 'openai', undefined, undefined, opts({ fetchImpl: server.fetchImpl, responseFormat: 'json' })), /503/)
  assert.equal(server.calls.length, 1)
})

test('callLLM records provider-reported cost when present (OpenRouter usage.cost)', async () => {
  const logged: LlmUsageLogEntry[] = []
  const { fetchImpl } = mockFetch(() => okJson(completion('hi', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0000423 })))
  const result = await callLLM(messages, 'openrouter', 'x/y', undefined, opts({ fetchImpl, logUsage: (entry) => logged.push(entry) }))
  assert.equal(result.usage?.costUsd, 0.0000423)
  assert.equal(logged[0]!.costUsd, 0.0000423)
})

test('callLLM turns OpenRouter reasoning off by default and never sends it to OpenAI', async () => {
  const router = mockFetch(() => okJson(completion('ok')))
  await callLLM(messages, 'openrouter', 'x/y', undefined, opts({ fetchImpl: router.fetchImpl }))
  assert.deepEqual(router.calls[0]!.body.reasoning, { enabled: false })
  const openai = mockFetch(() => okJson(completion('ok')))
  await callLLM(messages, 'openai', 'gpt-4o-mini', undefined, opts({ fetchImpl: openai.fetchImpl }))
  assert.equal(openai.calls[0]!.body.reasoning, undefined)
})

test('openRouterReasoning follows LLM_REASONING_EFFORT', () => {
  assert.deepEqual(openRouterReasoning({}), { enabled: false })
  assert.deepEqual(openRouterReasoning({ LLM_REASONING_EFFORT: 'low' }), { effort: 'low' })
  assert.deepEqual(openRouterReasoning({ LLM_REASONING_EFFORT: 'HIGH' }), { effort: 'high' })
  assert.deepEqual(openRouterReasoning({ LLM_REASONING_EFFORT: 'off' }), { enabled: false })
  assert.equal(openRouterReasoning({ LLM_REASONING_EFFORT: 'default' }), undefined)
  assert.deepEqual(openRouterReasoning({ LLM_REASONING_EFFORT: 'bogus' }), { enabled: false })
})

test('callLLM explains a reasoning model that used the whole token budget, and still logs usage', async () => {
  const logged: LlmUsageLogEntry[] = []
  const { fetchImpl } = mockFetch(() => okJson({
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null, reasoning: 'thinking...' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 4096, total_tokens: 5096, cost: 0.0037 },
  }))
  await assert.rejects(
    callLLM(messages, 'openrouter', 'x/y', undefined, opts({ fetchImpl, logUsage: (entry) => logged.push(entry) })),
    /ran out of output tokens/,
  )
  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.completionTokens, 4096)
})

test('callLLM sends temperature only when asked', async () => {
  const { fetchImpl, calls } = mockFetch(() => okJson(completion('ok')))
  await callLLM(messages, 'openrouter', undefined, undefined, opts({ fetchImpl, temperature: 0 }))
  await callLLM(messages, 'openrouter', undefined, undefined, opts({ fetchImpl }))
  assert.equal(calls[0]!.body.temperature, 0)
  assert.equal('temperature' in calls[1]!.body, false)
})
