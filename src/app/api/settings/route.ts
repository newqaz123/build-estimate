import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument, setDocument } from '@/lib/db'
import {
  DEFAULT_SETTINGS,
  fromStoredSettings,
  type StoredWorkspaceSettings,
  WORKSPACE_SETTINGS_ID,
} from '@/lib/settings-storage'
import type { DoclingSettings, FuzzySettings, LlmSettings, PromptSettings } from '@/lib/settings-schema'

const MAX_ENDPOINT_LENGTH = 2048
const MAX_PROMPT_LENGTH = 20_000
const PROVIDERS = new Set(['openai', 'anthropic', 'google', 'openrouter'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isBoundedString(value: unknown, max: number, allowBlank = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowBlank || value.trim().length > 0)
}

function isHttpUrl(value: unknown, optional = false) {
  if (optional && (value === undefined || value === '')) return true
  if (!isBoundedString(value, MAX_ENDPOINT_LENGTH)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function validateSection(section: unknown, data: unknown): { valid: true; data: LlmSettings | DoclingSettings | FuzzySettings | PromptSettings } | { valid: false; error: string } {
  if (!isPlainRecord(data)) return { valid: false, error: 'Settings data must be an object' }
  if (section === 'llm') {
    if (!hasOnlyKeys(data, ['provider', 'model', 'endpoint']) || !PROVIDERS.has(String(data.provider)) || !isBoundedString(data.model, 200) || !isHttpUrl(data.endpoint, true)) return { valid: false, error: 'Invalid LLM settings' }
    return { valid: true, data: data as unknown as LlmSettings }
  }
  if (section === 'docling') {
    if (!hasOnlyKeys(data, ['endpoint']) || !isHttpUrl(data.endpoint)) return { valid: false, error: 'Invalid Docling endpoint' }
    return { valid: true, data: data as unknown as DoclingSettings }
  }
  if (section === 'fuzzy') {
    if (!hasOnlyKeys(data, ['unitMap', 'normalizeRules']) || !isPlainRecord(data.unitMap) || Object.keys(data.unitMap).length > 200 || !Object.entries(data.unitMap).every(([key, value]) => key.length > 0 && key.length <= 100 && isBoundedString(value, 100)) || !Array.isArray(data.normalizeRules) || data.normalizeRules.length > 200 || !data.normalizeRules.every((rule) => Array.isArray(rule) && rule.length === 2 && rule.every((part) => isBoundedString(part, 500, true)))) return { valid: false, error: 'Invalid fuzzy matching rules' }
    return { valid: true, data: data as unknown as FuzzySettings }
  }
  if (section === 'prompts') {
    if (!hasOnlyKeys(data, ['analysisPrompt', 'stdPrompt', 'estimatePrompt']) || !isBoundedString(data.analysisPrompt, MAX_PROMPT_LENGTH) || !isBoundedString(data.stdPrompt, MAX_PROMPT_LENGTH) || !isBoundedString(data.estimatePrompt, MAX_PROMPT_LENGTH)) return { valid: false, error: 'Prompts must be nonblank and no longer than 20000 characters' }
    return { valid: true, data: data as unknown as PromptSettings }
  }
  return { valid: false, error: 'Invalid section' }
}

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const existing = await getDocument<StoredWorkspaceSettings>('settings', WORKSPACE_SETTINGS_ID)
    if (!existing) {
      return NextResponse.json(DEFAULT_SETTINGS)
    }
    return NextResponse.json(fromStoredSettings(existing))
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
    const body: unknown = await request.json()
    if (!isPlainRecord(body) || !hasOnlyKeys(body, ['section', 'data'])) return NextResponse.json({ error: 'Malformed settings request' }, { status: 400 })
    const result = validateSection(body.section, body.data)
    if (!result.valid) return NextResponse.json({ error: result.error }, { status: 400 })
    const section = body.section as 'llm' | 'docling' | 'fuzzy' | 'prompts'
    const persistedData = section === 'fuzzy'
      ? {
          ...(result.data as FuzzySettings),
          normalizeRules: (result.data as FuzzySettings).normalizeRules.map(([find, replace]) => ({ find, replace })),
        }
      : result.data
    await setDocument('settings', WORKSPACE_SETTINGS_ID, { [section]: persistedData })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Malformed JSON request' }, { status: 400 })
    console.error('Error updating settings:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
