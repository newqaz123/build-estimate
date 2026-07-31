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
