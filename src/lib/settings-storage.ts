import { withPromptDefaults } from './prompt-defaults'
import { sanitizeCustomUnits } from './units'
import type {
  DoclingSettings,
  FuzzySettings,
  LlmSettings,
  PromptSettings,
  WorkspaceSettings,
} from './settings-schema'

export const WORKSPACE_SETTINGS_ID = 'workspace'

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
    unitMap: { LS: 'L/S', SQFT: 'sq ft', SQM: 'sq m' },
    normalizeRules: [
      ['\\bsq\\.?\\s*ft\\b', 'sq ft'],
      ['\\bsq\\.?\\s*m\\b', 'sq m'],
    ],
  },
  prompts: withPromptDefaults(),
  units: { customUnits: [] },
}

export interface StoredWorkspaceSettings {
  llm?: LlmSettings
  docling?: DoclingSettings
  fuzzy?: Omit<FuzzySettings, 'normalizeRules'> & {
    normalizeRules?: unknown
  }
  prompts?: Partial<PromptSettings>
  units?: { customUnits?: unknown }
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
  }
}
