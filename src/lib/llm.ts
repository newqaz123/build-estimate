export async function callLLM(
  messages: { role: string; content: string }[],
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
