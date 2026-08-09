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
  estimatePrompt: string
}

export interface UnitSettings {
  customUnits: string[]
}

export type ActionableReviewStage =
  | 'off'
  | 'shadow'
  | 'focused'
  | 'add_and_match'
  | 'default'

export interface ActionableReviewSettings {
  stage: ActionableReviewStage
  lowCostModel?: string
  escalationModel?: string
  maxRows: number
  maxPromptTokens: number
  maxEstimatedCostMinor: number
  escalationEnabled: boolean
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
  units: UnitSettings
  actionableReview: ActionableReviewSettings
}
