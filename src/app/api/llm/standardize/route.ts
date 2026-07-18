import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { callLLM } from '@/lib/llm'
import { getDocument, queryCollection } from '@/lib/db'
import type { WorkspaceSettings } from '@/lib/settings-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import {
  buildCatalogStandardizationPrompt,
  normalizeCatalogStandardizationResponse,
  parseCatalogStandardizationRequest,
} from '@/lib/catalog-standardization'

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json() as {
      items?: unknown
      provider?: string
      model?: string
    }
    let structured
    try {
      structured = parseCatalogStandardizationRequest(body)
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid request.' }, { status: 400 })
    }

    const [settings, catalogResult] = await Promise.all([
      getDocument<WorkspaceSettings>('settings', 'workspace'),
      queryCollection<StandardEntry>('standards', { orderByField: 'description', orderDirection: 'asc' }),
    ])
    const standards = catalogResult.docs.filter((entry) => !entry.archivedAt)
    if (standards.length === 0) return NextResponse.json({ suggestions: [] })
    const stdPrompt = settings?.prompts?.stdPrompt || 'Translate the following parsed BOQ items to standard descriptions:'
    const messages = [
      { role: 'system', content: stdPrompt },
      { role: 'user', content: buildCatalogStandardizationPrompt(structured, standards) },
    ]
    const result = await callLLM(messages, body.provider, body.model, request.signal)
    return NextResponse.json({
      suggestions: normalizeCatalogStandardizationResponse(result.content, structured, standards),
      provider: result.provider,
      model: result.model,
    })
  } catch (error) {
    console.error('Catalog standardization failed:', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ error: 'Catalog suggestions are unavailable.' }, { status: 503 })
  }
}
