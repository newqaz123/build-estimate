import type { StandardEntry } from './standard-schema'

export interface CatalogAiSuggestionResult {
  candidate: StandardEntry | null
  reason: string
}

function parsePayload(payload: unknown): unknown {
  const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const content = envelope?.content ?? envelope?.text ?? payload

  if (typeof content !== 'string') return content

  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned) as unknown
  } catch {
    return null
  }
}

export function resolveCatalogAiSuggestion(
  payload: unknown,
  standards: StandardEntry[],
): CatalogAiSuggestionResult {
  const parsed = parsePayload(payload)
  const suggestion = Array.isArray(parsed) ? parsed[0] : parsed

  if (!suggestion || typeof suggestion !== 'object') {
    return { candidate: null, reason: 'AI returned no catalog suggestion we could verify.' }
  }

  const values = suggestion as Record<string, unknown>
  const matchedStdId = typeof values.matchedStdId === 'string'
    ? values.matchedStdId.trim()
    : typeof values.standardId === 'string'
      ? values.standardId.trim()
      : typeof values.stdId === 'string'
        ? values.stdId.trim()
        : ''
  const candidateById = standards.find((standard) => standard.id === matchedStdId)
  const candidate = candidateById ?? null
  const reason = candidate
    ? typeof values.reason === 'string' && values.reason.trim()
      ? values.reason.trim()
      : 'AI suggestion verified against the active catalog.'
    : 'AI suggestion could not be verified against the active catalog.'

  return { candidate, reason }
}
