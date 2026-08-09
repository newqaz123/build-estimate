export type LlmMessage = { role: string; content: string }

export type LlmCall = (
  messages: LlmMessage[],
  provider?: string,
  model?: string,
  signal?: AbortSignal,
) => Promise<{ content: string; provider: string; model: string }>

export async function callLLM(
  messages: LlmMessage[],
  provider?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<{ content: string; provider: string; model: string }> {
  const activeProvider = provider || process.env.LLM_PROVIDER || 'openai'
  const activeModel = model || process.env.LLM_MODEL || (activeProvider === 'openrouter' ? 'openai/gpt-4o' : 'gpt-4o')

  if (activeProvider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      signal,
      body: JSON.stringify({ model: activeModel, messages }),
    })
    if (!res.ok) throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`)
    const data = await res.json()
    return { content: data.choices[0].message.content, provider: 'openrouter', model: activeModel }
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    signal,
    body: JSON.stringify({ model: activeModel, messages }),
  })
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${res.statusText}`)
  const data = await res.json()
  return { content: data.choices[0].message.content, provider: 'openai', model: activeModel }
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
    const result = await invoke(messages, deps.provider, model, deps.signal)
    const content = result.content.trim()
    try {
      return JSON.parse(content) as unknown
    } catch {
      // Surface malformed provider text as a structured envelope the batch parser rejects.
      return { malformed: true, content }
    }
  }
}
