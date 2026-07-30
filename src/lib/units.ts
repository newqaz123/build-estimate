/** Canonical construction units, aligned with the Settings page rate-book docs. */
export const STANDARD_UNITS = [
  'm³', 'm²', 'm', 'ton', 'ea', 'set', 'kg', 'LS', 'no.', 'lot', 'hr', 'day',
] as const

export type UnitOption = string

/** Case-insensitive substring filter; de-duplicates (case-insensitive), preserving first-seen order. */
export function filterUnits(units: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const unit of units) {
    const key = unit.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (needle === '' || key.includes(needle)) out.push(unit)
  }
  return out
}

/** Trim a newly-typed unit. Returns null when empty or already present (case-insensitive). */
export function normalizeNewUnit(raw: string, existing: readonly string[]): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (existing.some((unit) => unit.toLowerCase() === trimmed.toLowerCase())) return null
  return trimmed
}

export const MAX_CUSTOM_UNITS = 200
export const MAX_UNIT_LENGTH = 24

export class WorkspaceUnitError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message)
    this.name = 'WorkspaceUnitError'
  }
}

export interface WorkspaceUnitMergeResult {
  unit: string
  customUnits: string[]
  added: boolean
}

export function normalizeWorkspaceUnit(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new WorkspaceUnitError('Unit must be a string.', 400)
  }
  const unit = raw.trim()
  if (!unit) throw new WorkspaceUnitError('Unit is required.', 400)
  if (unit.length > MAX_UNIT_LENGTH) {
    throw new WorkspaceUnitError(`Unit must be ${MAX_UNIT_LENGTH} characters or fewer.`, 400)
  }
  if (/[\u0000-\u001F\u007F]/.test(unit)) {
    throw new WorkspaceUnitError('Unit cannot contain control characters.', 400)
  }
  return unit
}

export function findCanonicalUnit(
  units: readonly string[],
  raw: string,
): string | undefined {
  const key = raw.toLowerCase()
  return units.find((unit) => unit.toLowerCase() === key)
}

export function sanitizeCustomUnits(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const value of raw) {
    try {
      const unit = normalizeWorkspaceUnit(value)
      if (!findCanonicalUnit([...STANDARD_UNITS, ...result], unit)) result.push(unit)
    } catch {
      continue
    }
    if (result.length === MAX_CUSTOM_UNITS) break
  }
  return result
}

export function combineUnitOptions(customUnits: unknown): string[] {
  return [...STANDARD_UNITS, ...sanitizeCustomUnits(customUnits)]
}

export function mergeWorkspaceUnit(
  current: readonly string[],
  raw: unknown,
): WorkspaceUnitMergeResult {
  const customUnits = sanitizeCustomUnits(current)
  const unit = normalizeWorkspaceUnit(raw)
  const canonical = findCanonicalUnit([...STANDARD_UNITS, ...customUnits], unit)
  if (canonical) return { unit: canonical, customUnits, added: false }
  if (customUnits.length >= MAX_CUSTOM_UNITS) {
    throw new WorkspaceUnitError('Workspace unit limit reached.', 409)
  }
  return {
    unit,
    customUnits: [...customUnits, unit],
    added: true,
  }
}
