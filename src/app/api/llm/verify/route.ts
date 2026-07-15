import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument } from '@/lib/db'
import { callLLM } from '@/lib/llm'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import { executeVerification } from './verify-api'

const VERIFY_TIMEOUT_MS = 20_000

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

  const result = await executeVerification(body, {
    getSettings: () => getDocument<WorkspaceSettings>('settings', 'workspace'),
    callProvider: callLLM,
    env: process.env,
    timeoutMs: VERIFY_TIMEOUT_MS,
    // Categories are safe to log; review content, upstream bodies, and credentials are not.
    logCategory: (category) => console.warn('BOQ AI verification fallback', { category }),
  })
  return NextResponse.json(result.body, { status: result.status })
}
