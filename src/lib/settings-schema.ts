export interface LlmSettings {
  provider: 'openai' | 'anthropic' | 'google' | 'openrouter'
  model: string
  endpoint?: string
}

export interface DoclingSettings {
  endpoint: string
}

export interface FuzzySettings {
  unitMap: Record<string, string>
  normalizeRules: [string, string][]
}

export interface PromptSettings {
  analysisPrompt: string
  stdPrompt: string
}

export interface Vendor {
  id: string
  name: string
  contact: string
  specialty: string
  linkedBoqCount: number
  lastUsed: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceSettings {
  llm: LlmSettings
  docling: DoclingSettings
  fuzzy: FuzzySettings
  prompts: PromptSettings
}
