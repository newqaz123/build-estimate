import {
  WorkspaceUnitError,
  type WorkspaceUnitMergeResult,
} from '@/lib/units'

interface WorkspaceUnitsHandlerDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  addUnit: (unit: unknown) => Promise<WorkspaceUnitMergeResult>
}

export function createWorkspaceUnitsPostHandler({
  authenticate,
  addUnit,
}: WorkspaceUnitsHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const session = await authenticate()
    if (!session?.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
      const body: unknown = await request.json()
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

      const result = await addUnit((body as { unit: unknown }).unit)
      return Response.json({
        unit: result.unit,
        customUnits: result.customUnits,
      })
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json(
          { error: 'Request body must be valid JSON.' },
          { status: 400 },
        )
      }
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
