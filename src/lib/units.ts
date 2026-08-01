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
    readonly status: 400 | 404 | 409,
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

/** Remove a custom unit. Throws WorkspaceUnitError(404) if it is not present. */
export function removeWorkspaceUnit(
  existing: readonly string[],
  unit: string,
): string[] {
  const customUnits = sanitizeCustomUnits(existing)
  const idx = customUnits.indexOf(unit)
  if (idx === -1) {
    throw new WorkspaceUnitError('Unit is not a custom unit.', 404)
  }
  return [...customUnits.slice(0, idx), ...customUnits.slice(idx + 1)]
}

/** Rename a custom unit in place. oldUnit must exist; newUnit is normalised. */
export function renameWorkspaceUnit(
  existing: readonly string[],
  oldUnit: string,
  newUnit: string,
): { customUnits: string[] } {
  const customUnits = sanitizeCustomUnits(existing)
  const idx = customUnits.indexOf(oldUnit)
  if (idx === -1) {
    throw new WorkspaceUnitError('Unit is not a custom unit.', 404)
  }
  // A rename to the same canonical value is a no-op success.
  if (oldUnit === newUnit.trim()) {
    return { customUnits }
  }
  const others = [...customUnits.slice(0, idx), ...customUnits.slice(idx + 1)]
  // Validate exactly like add (mergeWorkspaceUnit): full surface (empty /
  // over-length / control chars) via normalizeWorkspaceUnit, then a collision
  // check against the standard units plus the remaining custom units.
  const normalised = normalizeWorkspaceUnit(newUnit)
  if (findCanonicalUnit([...STANDARD_UNITS, ...others], normalised)) {
    throw new WorkspaceUnitError('Unit already exists.', 400)
  }
  return { customUnits: [...customUnits.slice(0, idx), normalised, ...customUnits.slice(idx + 1)] }
}

/**
 * Counts priced BOQ items per unit string. Bundle children
 * (`pricingRole === 'bundle_child'`) are informational and excluded.
 */
export function mapUnitUsage(
  boqs: readonly { sections: { items: readonly unknown[] }[] }[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const boq of boqs) {
    for (const section of boq.sections) {
      for (const item of section.items as readonly { pricingRole?: string; unit?: unknown }[]) {
        if (item.pricingRole === 'bundle_child') continue
        if (typeof item.unit !== 'string') continue
        counts[item.unit] = (counts[item.unit] ?? 0) + 1
      }
    }
  }
  return counts
}

/** Single-unit usage count derived from {@link mapUnitUsage}. */
export function countUnitUsage(
  boqs: readonly { sections: { items: readonly unknown[] }[] }[],
  unit: string,
): number {
  return mapUnitUsage(boqs)[unit] ?? 0
}
