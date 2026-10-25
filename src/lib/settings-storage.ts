import { withPromptDefaults } from './prompt-defaults'
import { sanitizeCustomUnits } from './units'
import type {
  ActionableReviewSettings,
  ActionableReviewStage,
  DoclingSettings,
  FuzzySettings,
  LlmSettings,
  PromptSettings,
  WorkspaceSettings,
} from './settings-schema'

export const WORKSPACE_SETTINGS_ID = 'workspace'

const ACTIONABLE_REVIEW_STAGES = new Set<ActionableReviewStage>([
  'off',
  'shadow',
  'focused',
  'add_and_match',
  'default',
])

const ACTIONABLE_REVIEW_KEYS = new Set([
  'stage',
  'lowCostModel',
  'escalationModel',
  'maxRows',
  'maxPromptTokens',
  'maxEstimatedCostMinor',
  'escalationEnabled',
])

export const DEFAULT_ACTIONABLE_REVIEW_SETTINGS: ActionableReviewSettings = {
  stage: 'off',
  maxRows: 100,
  maxPromptTokens: 8_000,
  maxEstimatedCostMinor: 0,
  escalationEnabled: true,
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && Number.isFinite(value)
    && value >= 0
}

function isBoundedModelName(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 200
}

export function parseActionableReviewSettings(value: unknown): ActionableReviewSettings {
  if (!isPlainRecord(value)) {
    throw new Error('Invalid actionable review settings')
  }
  for (const key of Object.keys(value)) {
    if (!ACTIONABLE_REVIEW_KEYS.has(key)) {
      throw new Error('Invalid actionable review settings')
    }
  }
  if (
    typeof value.stage !== 'string'
    || !ACTIONABLE_REVIEW_STAGES.has(value.stage as ActionableReviewStage)
    || !isNonNegativeInteger(value.maxRows)
    || !isNonNegativeInteger(value.maxPromptTokens)
    || !isNonNegativeInteger(value.maxEstimatedCostMinor)
    || typeof value.escalationEnabled !== 'boolean'
  ) {
    throw new Error('Invalid actionable review settings')
  }
  if (value.lowCostModel !== undefined && !isBoundedModelName(value.lowCostModel)) {
    throw new Error('Invalid actionable review settings')
  }
  if (value.escalationModel !== undefined && !isBoundedModelName(value.escalationModel)) {
    throw new Error('Invalid actionable review settings')
  }

  const parsed: ActionableReviewSettings = {
    stage: value.stage as ActionableReviewStage,
    maxRows: value.maxRows,
    maxPromptTokens: value.maxPromptTokens,
    maxEstimatedCostMinor: value.maxEstimatedCostMinor,
    escalationEnabled: value.escalationEnabled,
  }
  if (typeof value.lowCostModel === 'string') {
    parsed.lowCostModel = value.lowCostModel
  }
  if (typeof value.escalationModel === 'string') {
    parsed.escalationModel = value.escalationModel
  }
  return parsed
}

export function decodeNormalizeRules(
  value: unknown,
  defaults: [string, string][],
): [string, string][] {
  if (!Array.isArray(value)) return defaults.map(([find, replace]) => [find, replace])
  if (value.length === 0) return []

  const decoded: [string, string][] = []

  for (const rule of value) {
    if (
      Array.isArray(rule)
      && rule.length === 2
      && typeof rule[0] === 'string'
      && typeof rule[1] === 'string'
    ) {
      decoded.push([rule[0], rule[1]])
      continue
    }

    if (
      typeof rule === 'object'
      && rule !== null
      && !Array.isArray(rule)
      && typeof (rule as Record<string, unknown>).find === 'string'
      && typeof (rule as Record<string, unknown>).replace === 'string'
    ) {
      decoded.push([
        (rule as Record<string, string>).find,
        (rule as Record<string, string>).replace,
      ])
    }
  }

  return decoded.length > 0
    ? decoded
    : defaults.map(([find, replace]) => [find, replace])
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  llm: { provider: 'openai', model: 'gpt-4o' },
  docling: { endpoint: 'http://localhost:5001' },
  fuzzy: {
    // Common synonyms (LS/L/S/เหมา, sq.m/ตร.ม., No./pcs/ตัว ...) are built into
    // canonicalUnit; this map is for workspace-specific units on top of them.
    unitMap: { LS: 'lot', SQFT: 'sq ft', SQM: 'm2' },
    normalizeRules: [
      ['\\bsq\\.?\\s*ft\\b', 'sq ft'],
      ['\\bsq\\.?\\s*m\\b', 'sq m'],
    ],
  },
  prompts: withPromptDefaults(),
  units: { customUnits: [] },
  actionableReview: DEFAULT_ACTIONABLE_REVIEW_SETTINGS,
}

export interface StoredWorkspaceSettings {
  llm?: LlmSettings
  docling?: DoclingSettings
  fuzzy?: Omit<FuzzySettings, 'normalizeRules'> & {
    normalizeRules?: unknown
  }
  prompts?: Partial<PromptSettings>
  units?: { customUnits?: unknown }
  actionableReview?: unknown
}

export function toStoredSettings(settings: WorkspaceSettings): StoredWorkspaceSettings {
  return {
    ...settings,
    fuzzy: settings.fuzzy
      ? {
          ...settings.fuzzy,
          // Firestore rejects arrays nested directly inside another array.
          normalizeRules: settings.fuzzy.normalizeRules.map(([find, replace]) => ({ find, replace })),
        }
      : undefined,
    units: { customUnits: sanitizeCustomUnits(settings.units.customUnits) },
    actionableReview: parseActionableReviewSettings(settings.actionableReview),
  }
}

export function fromStoredSettings(
  stored: StoredWorkspaceSettings | null | undefined,
): WorkspaceSettings {
  return {
    llm: stored?.llm ?? DEFAULT_SETTINGS.llm,
    docling: stored?.docling ?? DEFAULT_SETTINGS.docling,
    fuzzy: stored?.fuzzy
      ? {
          unitMap: stored.fuzzy.unitMap ?? DEFAULT_SETTINGS.fuzzy.unitMap,
          normalizeRules: decodeNormalizeRules(
            stored.fuzzy.normalizeRules,
            DEFAULT_SETTINGS.fuzzy.normalizeRules,
          ),
        }
      : DEFAULT_SETTINGS.fuzzy,
    prompts: withPromptDefaults(stored?.prompts),
    units: {
      customUnits: sanitizeCustomUnits(stored?.units?.customUnits),
    },
    actionableReview: stored?.actionableReview === undefined
      ? { ...DEFAULT_ACTIONABLE_REVIEW_SETTINGS }
      : parseActionableReviewSettings(stored.actionableReview),
  }
}
