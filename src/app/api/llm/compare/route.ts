import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { callLLM } from '@/lib/llm'

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

    const result = await callLLM(messages, provider, model)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Error in LLM compare:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
