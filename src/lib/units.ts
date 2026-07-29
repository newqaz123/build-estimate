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
