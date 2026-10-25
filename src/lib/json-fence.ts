/** Strip one conventional ```json fence around a model reply; otherwise trim. */
export function unwrapConventionalJsonFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i.exec(trimmed)
  if (!fenced) return trimmed
  return fenced[1]!.trim()
}
