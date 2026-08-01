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

export class WorkspaceUnitInUseError extends Error {
  readonly usageCount: number
  constructor(message: string, usageCount: number) {
    super(message)
    this.name = 'WorkspaceUnitInUseError'
    this.usageCount = usageCount
  }
}

export interface WorkspaceUnitsOverview {
  standardUnits: string[]
  customUnits: string[]
  usage: Record<string, number>
}

export async function fetchWorkspaceUnitsOverview(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WorkspaceUnitsOverview> {
  const response = await fetchImpl('/api/settings/units', { signal })
  if (!response.ok) await responseError(response)
  const body: unknown = await response.json()
  const obj = body as { standardUnits?: unknown; customUnits?: unknown; usage?: unknown }
  if (
    typeof body !== 'object' || body === null || Array.isArray(body)
    || !Array.isArray(obj.standardUnits) || !Array.isArray(obj.customUnits)
    || typeof obj.usage !== 'object' || obj.usage === null
  ) {
    throw new Error('Workspace units overview returned an invalid response.')
  }
  return {
    standardUnits: (obj.standardUnits as unknown[]).filter((u): u is string => typeof u === 'string'),
    customUnits: sanitizeCustomUnits(obj.customUnits),
    usage: obj.usage as Record<string, number>,
  }
}

export async function removeWorkspaceUnit(
  unit: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ customUnits: string[] }> {
  const response = await fetchImpl('/api/settings/units', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit }),
  })
  if (response.status === 409) {
    let usageCount = 0
    try {
      const body = (await response.json()) as { usageCount?: unknown }
      if (typeof body.usageCount === 'number') usageCount = body.usageCount
    } catch {
      // keep 0
    }
    throw new WorkspaceUnitInUseError('Unit is in use by existing BOQ items.', usageCount)
  }
  if (!response.ok) await responseError(response)
  const body: unknown = await response.json()
  const customUnits = (body as { customUnits?: unknown }).customUnits
  if (!Array.isArray(customUnits)) {
    throw new Error('Workspace units returned an invalid response.')
  }
  return { customUnits: sanitizeCustomUnits(customUnits) }
}

export async function renameWorkspaceUnit(
  oldUnit: string,
  newUnit: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ customUnits: string[]; updatedItems: number }> {
  const response = await fetchImpl('/api/settings/units', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldUnit, newUnit }),
  })
  if (!response.ok) await responseError(response)
  const body: unknown = await response.json()
  const obj = body as { customUnits?: unknown; updatedItems?: unknown }
  if (!Array.isArray(obj.customUnits) || typeof obj.updatedItems !== 'number') {
    throw new Error('Workspace units returned an invalid response.')
  }
  return { customUnits: sanitizeCustomUnits(obj.customUnits), updatedItems: obj.updatedItems }
}
