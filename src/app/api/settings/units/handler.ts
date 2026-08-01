import {
  mapUnitUsage,
  STANDARD_UNITS,
  sanitizeCustomUnits,
  WorkspaceUnitError,
  type WorkspaceUnitMergeResult,
} from '@/lib/units'
import {
  fromStoredSettings,
  type StoredWorkspaceSettings,
} from '@/lib/settings-storage'

interface WorkspaceUnitsHandlerDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  addUnit: (unit: unknown) => Promise<WorkspaceUnitMergeResult>
}

export function createWorkspaceUnitsPostHandler({
  authenticate,
  addUnit,
}: WorkspaceUnitsHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    let session
    try {
      session = await authenticate()
    } catch (error) {
      // An authentication backend rejection (Firestore/JWT/transport error)
      // must surface as a generic 500 so infrastructure details never leak.
      // The normal unauthenticated result remains a 401 below.
      console.error('Error authenticating workspace unit request:', error)
      return Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      )
    }
    if (!session?.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse the request body in its own narrow try/catch so that a
    // SyntaxError from storage/Firestore (raised by addUnit below) can never
    // be mistaken for malformed JSON.
    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json(
          { error: 'Request body must be valid JSON.' },
          { status: 400 },
        )
      }
      console.error('Error reading workspace unit request:', error)
      return Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      )
    }

    if (
      typeof body !== 'object'
      || body === null
      || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !('unit' in body)
    ) {
      return Response.json(
        { error: 'Request must contain only unit.' },
        { status: 400 },
      )
    }

    try {
      const result = await addUnit((body as { unit: unknown }).unit)
      return Response.json({
        unit: result.unit,
        customUnits: result.customUnits,
      })
    } catch (error) {
      if (error instanceof WorkspaceUnitError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        )
      }
      console.error('Error adding workspace unit:', error)
      return Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      )
    }
  }
}

interface WorkspaceUnitsGetDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  readSettings: () => Promise<unknown | null>
  readAllBoqs: () => Promise<Array<{ id: string; data: unknown }>>
}

export function createWorkspaceUnitsGetHandler({
  authenticate,
  readSettings,
  readAllBoqs,
}: WorkspaceUnitsGetDependencies) {
  return async function GET(request: Request): Promise<Response> {
    let session
    try {
      session = await authenticate()
    } catch (error) {
      console.error('Error authenticating workspace units overview:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    try {
      const settings = fromStoredSettings(
        (await readSettings()) as StoredWorkspaceSettings | null,
      )
      const customUnits = sanitizeCustomUnits(settings.units.customUnits)
      const boqs = await readAllBoqs()
      const all = mapUnitUsage(
        boqs.map(({ data }) => data) as ReadonlyArray<{
          sections: { items: readonly unknown[] }[]
        }>,
      )
      const usage: Record<string, number> = {}
      for (const unit of customUnits) usage[unit] = all[unit] ?? 0
      return Response.json({ standardUnits: [...STANDARD_UNITS], customUnits, usage })
    } catch (error) {
      console.error('Error reading workspace units overview:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}

interface WorkspaceUnitsDeleteDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  countUsage: (unit: string) => Promise<number>
  removeUnit: (unit: string) => Promise<{ customUnits: string[] }>
}

export function createWorkspaceUnitsDeleteHandler({
  authenticate,
  countUsage,
  removeUnit,
}: WorkspaceUnitsDeleteDependencies) {
  return async function DELETE(request: Request): Promise<Response> {
    let session
    try {
      session = await authenticate()
    } catch (error) {
      console.error('Error authenticating workspace unit delete:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
      }
      console.error('Error reading workspace unit delete:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (
      typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body as object).length !== 1
      || (body as { unit?: unknown }).unit === undefined
      || typeof (body as { unit: unknown }).unit !== 'string'
    ) {
      return Response.json({ error: 'Request must contain only unit.' }, { status: 400 })
    }
    const unit = (body as { unit: string }).unit

    try {
      const usageCount = await countUsage(unit)
      if (usageCount > 0) {
        return Response.json(
          { error: 'Unit is in use by existing BOQ items.', usageCount },
          { status: 409 },
        )
      }
      const result = await removeUnit(unit)
      return Response.json({ customUnits: result.customUnits })
    } catch (error) {
      if (error instanceof WorkspaceUnitError) {
        return Response.json({ error: error.message }, { status: error.status })
      }
      console.error('Error deleting workspace unit:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}

interface WorkspaceUnitsPatchDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  renameUnit: (oldUnit: string, newUnit: string) => Promise<{ customUnits: string[]; updatedBoqs: number; updatedItems: number }>
}

export function createWorkspaceUnitsPatchHandler({
  authenticate,
  renameUnit,
}: WorkspaceUnitsPatchDependencies) {
  return async function PATCH(request: Request): Promise<Response> {
    let session
    try {
      session = await authenticate()
    } catch (error) {
      console.error('Error authenticating workspace unit rename:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
      }
      console.error('Error reading workspace unit rename:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    const obj = body as { oldUnit?: unknown; newUnit?: unknown }
    if (
      typeof body !== 'object' || body === null || Array.isArray(body)
      || typeof obj.oldUnit !== 'string' || typeof obj.newUnit !== 'string'
    ) {
      return Response.json(
        { error: 'Request must contain oldUnit and newUnit.' },
        { status: 400 },
      )
    }

    try {
      const result = await renameUnit(obj.oldUnit, obj.newUnit)
      return Response.json({ customUnits: result.customUnits, updatedItems: result.updatedItems })
    } catch (error) {
      if (error instanceof WorkspaceUnitError) {
        return Response.json({ error: error.message }, { status: error.status })
      }
      console.error('Error renaming workspace unit:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
