import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDb } from '@/lib/firebase-admin'
import type { DoclingSettings, FuzzySettings, LlmSettings, PromptSettings, WorkspaceSettings } from '@/lib/settings-schema'

const DEFAULT_SETTINGS: WorkspaceSettings = {
  llm: { provider: 'openai', model: 'gpt-4o' },
  docling: { endpoint: 'http://localhost:5001' },
  fuzzy: {
    unitMap: { LS: 'L/S', SQFT: 'sq ft', SQM: 'sq m' },
    normalizeRules: [['\\bsq\\.?\\s*ft\\b', 'sq ft'], ['\\bsq\\.?\\s*m\\b', 'sq m']],
  },
  prompts: {
    analysisPrompt: 'Analyze the parsed BOQ items for consistency and accuracy:',
    stdPrompt: 'Translate the following parsed BOQ items to standard descriptions:',
  },
}

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getDb()
    const doc = await db.collection('settings').doc('workspace').get()
    if (!doc.exists) {
      return NextResponse.json(DEFAULT_SETTINGS)
    }
    const data = doc.data() as WorkspaceSettings
    return NextResponse.json({ ...DEFAULT_SETTINGS, ...data })
  } catch (error) {
    console.error('Error fetching settings:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { section, data } = body as { section: 'llm' | 'docling' | 'fuzzy' | 'prompts'; data: LlmSettings | DoclingSettings | FuzzySettings | PromptSettings }

    if (!section || !data) {
      return NextResponse.json({ error: 'Missing section or data' }, { status: 400 })
    }

    const validSections = ['llm', 'docling', 'fuzzy', 'prompts']
    if (!validSections.includes(section)) {
      return NextResponse.json({ error: 'Invalid section' }, { status: 400 })
    }

    const db = getDb()
    await db.collection('settings').doc('workspace').set(
      { [section]: data },
      { merge: true }
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error updating settings:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
