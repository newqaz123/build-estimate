import { callLLM } from '@/lib/llm'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import {
  buildAiFallback,
  buildAiSuccess,
  buildVerificationMessages,
  classifyAiFailure,
  isSupportedVerificationProvider,
  normalizeAiVerification,
  parseVerificationRequest,
  providerKeyAvailable,
  resolveVerificationConfig,
  runLocalVerification,
  VerificationRequestError,
  type AiFallbackResponse,
  type AiSuccessResponse,
} from '@/lib/boq-verification'

type ProviderCall = (
  messages: { role: string; content: string }[],
  provider: string,
  model: string,
  signal: AbortSignal,
) => ReturnType<typeof callLLM>

export interface VerifyApiDependencies {
  getSettings: () => Promise<WorkspaceSettings | null>
  callProvider: ProviderCall
  env: Record<string, string | undefined>
  timeoutMs: number
  logCategory?: (category: string) => void
}

export type VerifyApiResult =
  | { status: 200; body: AiFallbackResponse | AiSuccessResponse }
  | { status: 400; body: { error: string } }

export async function executeVerification(
  body: unknown,
  dependencies: VerifyApiDependencies,
): Promise<VerifyApiResult> {
  let review
  try {
    review = parseVerificationRequest(body)
  } catch (error) {
    const message = error instanceof VerificationRequestError
      ? error.message
      : 'Malformed verification request'
    return { status: 400, body: { error: message } }
  }

  const local = runLocalVerification(review)
  let settings: WorkspaceSettings | null = null
  try {
    settings = await dependencies.getSettings()
  } catch {
    dependencies.logCategory?.('settings_unavailable')
  }

  const config = resolveVerificationConfig(review, settings?.llm, dependencies.env)
  if (!isSupportedVerificationProvider(config.provider)) {
    return { status: 200, body: buildAiFallback(local, 'unsupported_provider') }
  }
  if (!providerKeyAvailable(config.provider, dependencies.env)) {
    return { status: 200, body: buildAiFallback(local, 'provider_not_configured') }
  }

  let messages
  try {
    messages = buildVerificationMessages(review)
  } catch (error) {
    const message = error instanceof VerificationRequestError
      ? error.message
      : 'Verification payload is too large'
    return { status: 400, body: { error: message } }
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), dependencies.timeoutMs)
  try {
    const result = await dependencies.callProvider(
      messages,
      config.provider,
      config.model,
      controller.signal,
    )
    const aiIssues = normalizeAiVerification(result.content)
    return { status: 200, body: buildAiSuccess(local, aiIssues, config) }
  } catch (error) {
    const category = classifyAiFailure(error)
    dependencies.logCategory?.(category)
    return { status: 200, body: buildAiFallback(local, category) }
  } finally {
    clearTimeout(deadline)
  }
}
