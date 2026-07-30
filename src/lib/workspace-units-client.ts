import { sanitizeCustomUnits } from './units'

/**
 * Throws an `Error` whose message is the server-provided `error` string when
 * present, falling back to a generic status message. The server error string
 * is preserved verbatim so callers can surface domain messages (e.g. the
 * 409 cap-reached message) without translating them.
 */
async function responseError(response: Response): Promise<never> {
  let message = `Workspace units request failed with status ${response.status}.`
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object'
      && body !== null
      && typeof (body as { error?: unknown }).error === 'string'
    ) {
      message = (body as { error: string }).error
    }
  } catch {
    // Non-JSON error body: keep the generic status message.
  }
  throw new Error(message)
}

export async function loadWorkspaceCustomUnits(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetchImpl('/api/settings', { signal })
  if (!response.ok) {
    await responseError(response)
  }

  const body: unknown = await response.json()
  if (
    typeof body !== 'object'
    || body === null
    || Array.isArray(body)
  ) {
    throw new Error('Workspace units returned an invalid response.')
  }

  const units = (body as { units?: unknown }).units
  // Legacy settings documents have no `units` section; treat that as empty.
  if (units === undefined) return []

  if (
    typeof units !== 'object'
    || units === null
    || Array.isArray(units)
  ) {
    throw new Error('Workspace units returned an invalid response.')
  }

  const customUnits = (units as { customUnits?: unknown }).customUnits
  if (!Array.isArray(customUnits)) {
    throw new Error('Workspace units returned an invalid response.')
  }

  return sanitizeCustomUnits(customUnits)
}

export async function addWorkspaceUnit(
  unit: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ unit: string; customUnits: string[] }> {
  const response = await fetchImpl('/api/settings/units', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit }),
  })
  if (!response.ok) {
    await responseError(response)
  }

  const body: unknown = await response.json()
  if (
    typeof body !== 'object'
    || body === null
    || Array.isArray(body)
  ) {
    throw new Error('Workspace units returned an invalid response.')
  }

  const canonicalUnit = (body as { unit?: unknown }).unit
  const customUnits = (body as { customUnits?: unknown }).customUnits
  if (typeof canonicalUnit !== 'string' || !Array.isArray(customUnits)) {
    throw new Error('Workspace units returned an invalid response.')
  }

  return {
    unit: canonicalUnit,
    customUnits: sanitizeCustomUnits(customUnits),
  }
}
