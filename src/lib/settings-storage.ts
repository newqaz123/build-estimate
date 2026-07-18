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
