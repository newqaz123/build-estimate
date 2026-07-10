import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { callLLM } from '@/lib/llm'
import { getDocument } from '@/lib/db'
import type { WorkspaceSettings } from '@/lib/settings-schema'

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { messages, provider, model } = body as {
      messages: { role: string; content: string }[]
      provider?: string
      model?: string
    }

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'messages array is required' }, { status: 400 })
    }

    const settings = await getDocument<WorkspaceSettings>('settings', 'workspace')
    const stdPrompt = settings?.prompts?.stdPrompt || 'Translate the following parsed BOQ items to standard descriptions:'

    const augmentedMessages = [
      { role: 'system', content: stdPrompt },
      ...messages,
    ]

    const result = await callLLM(augmentedMessages, provider, model)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Error in LLM standardize:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
