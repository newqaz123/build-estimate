export type LlmMessage = { role: string; content: string }

export type LlmResponseFormat = 'text' | 'json'

export interface LlmCallOptions {
  /** Abort the provider request after this many ms (default 60s). */
  timeoutMs?: number
  /** Upper bound on completion tokens (default 4096). */
  maxTokens?: number
  /** 'json' asks the provider for a JSON object response (OpenAI-compatible json_object). */
  responseFormat?: LlmResponseFormat
  /** Test seams. */
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
  logUsage?: (entry: LlmUsageLogEntry) => void
}

export interface LlmUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Provider-reported cost in USD when available (OpenRouter returns usage.cost). */
  costUsd?: number
}

export interface LlmUsageLogEntry extends LlmUsage {
  provider: string
  model: string
  durationMs: number
}

export type LlmResult = { content: string; provider: string; model: string; usage?: LlmUsage }

export type LlmCall = (
  messages: LlmMessage[],
  provider?: string,
  model?: string,
  signal?: AbortSignal,
  options?: LlmCallOptions,
) => Promise<LlmResult>

export const DEFAULT_LLM_TIMEOUT_MS = 60_000
export const DEFAULT_LLM_MAX_TOKENS = 4096

const PROVIDERS = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', keyName: 'OPENAI_API_KEY', label: 'OpenAI', defaultModel: 'gpt-4o' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', keyName: 'OPENROUTER_API_KEY', label: 'OpenRouter', defaultModel: 'openai/gpt-4o' },
} as const

type ProviderName = keyof typeof PROVIDERS

function defaultUsageLogger(entry: LlmUsageLogEntry) {
  console.info(
    `[llm] ${entry.provider}/${entry.model} tokens prompt=${entry.promptTokens ?? '?'} completion=${entry.completionTokens ?? '?'} total=${entry.totalTokens ?? '?'}${entry.costUsd !== undefined ? ` cost=$${entry.costUsd.toFixed(6)}` : ''} in ${entry.durationMs}ms`,
  )
}

function readUsage(data: unknown): LlmUsage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const usage = (data as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const record = usage as Record<string, unknown>
  return {
    promptTokens: num(record.prompt_tokens),
    completionTokens: num(record.completion_tokens),
    totalTokens: num(record.total_tokens),
    ...(num(record.cost) !== undefined ? { costUsd: num(record.cost) } : {}),
  }
}

function readContent(data: unknown, label: string): string {
  const choices = typeof data === 'object' && data !== null ? (data as { choices?: unknown }).choices : undefined
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`${label} API returned no choices`)
  }
  const message = (choices[0] as { message?: { content?: unknown } } | null)?.message
  const content = message?.content
  if (typeof content !== 'string') {
    throw new Error(`${label} API returned a choice without text content`)
  }
  return content
}

/** OpenAI json_object mode requires the word "JSON" somewhere in the messages. */
function ensureJsonInstruction(messages: LlmMessage[]): LlmMessage[] {
  if (messages.some((message) => /json/i.test(message.content))) return messages
  return [{ role: 'system', content: 'Respond with a single JSON object.' }, ...messages]
}

export async function callLLM(
  messages: LlmMessage[],
  provider?: string,
  model?: string,
  signal?: AbortSignal,
  options: LlmCallOptions = {},
): Promise<LlmResult> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  const logUsage = options.logUsage ?? defaultUsageLogger

  const requestedProvider = provider || env.LLM_PROVIDER || 'openai'
  if (!(requestedProvider in PROVIDERS)) {
    throw new Error(`Unsupported LLM provider: ${requestedProvider}`)
  }
  const activeProvider = requestedProvider as ProviderName
  const config = PROVIDERS[activeProvider]
  const activeModel = model || env.LLM_MODEL || config.defaultModel

  const apiKey = env[config.keyName]?.trim()
  if (!apiKey) {
    throw new Error(`${config.label} API key is not configured (${config.keyName})`)
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  // AbortController + setTimeout rather than AbortSignal.timeout(): the timer is
  // cleared as soon as the provider answers, so nothing lingers per request.
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(new Error('LLM request timed out')), timeoutMs)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal

  const json = options.responseFormat === 'json'
  const body = {
    model: activeModel,
    messages: json ? ensureJsonInstruction(messages) : messages,
    max_tokens: options.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  }

  const startedAt = Date.now()
  let data: unknown
  const send = async (payload: Record<string, unknown>): Promise<Response> => fetchImpl(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: combinedSignal,
    body: JSON.stringify(payload),
  })
  try {
    try {
      let res = await send(body)
      if (!res.ok && json && (res.status === 400 || res.status === 422)) {
        // Some models/providers reject response_format. Degrade gracefully: retry
        // once as plain text (the messages still ask for JSON) and let callers
        // parse JSON from the text, including fenced JSON.
        const { response_format: _omitted, ...plain } = body
        void _omitted
        res = await send(plain)
      }
      if (!res.ok) throw new Error(`${config.label} API error: ${res.status} ${res.statusText}`)
      try {
        data = await res.json()
      } catch (error) {
        if (timeoutController.signal.aborted || signal?.aborted) throw error
        throw new Error(`${config.label} API returned a non-JSON response`)
      }
    } catch (error) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new Error(`${config.label} API request timed out after ${timeoutMs}ms`)
      }
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
  const content = readContent(data, config.label)
  const usage = readUsage(data)
  logUsage({ provider: activeProvider, model: activeModel, durationMs: Date.now() - startedAt, ...usage })
  return { content, provider: activeProvider, model: activeModel, ...(usage ? { usage } : {}) }
}

const ACTIONABLE_REVIEW_SYSTEM_PROMPT = [
  'You advise BOQ catalog actions for ambiguous extracted rows.',
  'Respond with JSON only: {"advice":[...]} using the closed schema.',
  'Each advice item may include only sourceRowId, decision, catalogId, conversionRuleId, proposedCatalogMetadata, confidence, reason.',
  'decision must be match|create|dismiss|uncertain.',
  'Select catalogId and conversionRuleId only from the provided allowlists.',
  'Never invent quantities, rates, totals, amounts, prices, or conversion factors.',
].join(' ')

/**
 * Thin adapter over the shared LLM call for actionable-review batches.
 * Validation/allowlisting remains in actionable-review-ai (fail-closed parser).
 */
export function createActionableReviewProviderCall(deps: {
  callLLM?: LlmCall
  provider?: string
  signal?: AbortSignal
} = {}): (input: {
  model: string
  rows: readonly unknown[]
  maxPromptTokens: number
}) => Promise<unknown> {
  const invoke = deps.callLLM ?? callLLM
  return async ({ model, rows, maxPromptTokens }) => {
    const messages: LlmMessage[] = [
      { role: 'system', content: ACTIONABLE_REVIEW_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          maxPromptTokens,
          rows,
        }),
      },
    ]
    const result = await invoke(messages, deps.provider, model, deps.signal, { responseFormat: 'json' })
    const content = unwrapConventionalJsonFence(result.content)
    try {
      return JSON.parse(content) as unknown
    } catch {
      // Surface malformed provider text as a structured envelope the batch parser rejects.
      return { malformed: true, content }
    }
  }
}

/**
 * Safely unwrap one conventional ``` / ```json fenced object before JSON.parse.
 * Anything else is returned trimmed for fail-closed parse.
 */
import { unwrapConventionalJsonFence } from './json-fence'
export { unwrapConventionalJsonFence }
