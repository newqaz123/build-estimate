import { callLLM } from './llm'

type Env = Record<string, string | undefined>
type ProviderCall = (
  messages: { role: string; content: string }[],
  provider: string,
  model: string,
  signal: AbortSignal,
) => ReturnType<typeof callLLM>

export interface LlmConnectionDependencies {
  env: Env
  callProvider: ProviderCall
  timeoutMs: number
}

export type LlmConnectionResult =
  | { status: 200; body: { provider: string; model: string } }
  | { status: 400 | 503; body: { error: string } }

const SUPPORTED_PROVIDERS = new Set(['openai', 'openrouter'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function executeLlmConnection(
  body: unknown,
  dependencies: LlmConnectionDependencies,
): Promise<LlmConnectionResult> {
  if (!isRecord(body)) return { status: 400, body: { error: 'request must be an object' } }
  const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : 'openai'
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : provider === 'openrouter' ? 'openai/gpt-4o' : 'gpt-4o'
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return { status: 400, body: { error: `${provider} testing is not supported by the current server runtime` } }
  }
  const keyName = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
  if (!dependencies.env[keyName]?.trim()) {
    return { status: 503, body: { error: `${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key is not configured` } }
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), dependencies.timeoutMs)
  try {
    const result = await dependencies.callProvider(
      [{ role: 'user', content: 'Reply with OK.' }],
      provider,
      model,
      controller.signal,
    )
    return { status: 200, body: { provider: result.provider, model: result.model } }
  } catch {
    return { status: 503, body: { error: 'LLM connection failed' } }
  } finally {
    clearTimeout(deadline)
  }
}
