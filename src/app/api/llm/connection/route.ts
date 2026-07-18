import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { callLLM } from '@/lib/llm'
import { executeLlmConnection } from '@/lib/llm-connection'

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed JSON request' }, { status: 400 })
  }
  const result = await executeLlmConnection(body, {
    env: process.env,
    callProvider: callLLM,
    timeoutMs: 30_000,
  })
  return NextResponse.json(result.body, { status: result.status })
}
