import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument } from '@/lib/db'
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
  type AiStatus,
} from '@/lib/boq-verification'

function localResponse(
  local: ReturnType<typeof runLocalVerification>,
  status: Exclude<AiStatus, 'completed'>,
) {
  return NextResponse.json(buildAiFallback(local, status))
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed JSON request' }, { status: 400 })
  }

  let review
  try {
    review = parseVerificationRequest(body)
  } catch (error) {
    if (error instanceof VerificationRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json({ error: 'Malformed verification request' }, { status: 400 })
  }

  // Local checks are deterministic and complete even if settings or the provider fail.
  const local = runLocalVerification(review)
  let settings: WorkspaceSettings | null = null
  try {
    settings = await getDocument<WorkspaceSettings>('settings', 'workspace')
  } catch {
    // Settings are optional for verification; environment defaults can still be used.
    console.warn('BOQ AI verification settings unavailable')
  }

  const config = resolveVerificationConfig(review, settings?.llm, process.env)
  if (!isSupportedVerificationProvider(config.provider)) {
    return localResponse(local, 'unsupported_provider')
  }
  if (!providerKeyAvailable(config.provider, process.env)) {
    return localResponse(local, 'provider_not_configured')
  }

  try {
    const result = await callLLM(buildVerificationMessages(review), config.provider, config.model)
    const aiIssues = normalizeAiVerification(result.content)
    return NextResponse.json(buildAiSuccess(local, aiIssues, config))
  } catch (error) {
    const category = classifyAiFailure(error)
    // Log only the category. Review content, upstream bodies, and credentials stay private.
    console.warn('BOQ AI verification fallback', { category })
    return localResponse(local, category)
  }
}
