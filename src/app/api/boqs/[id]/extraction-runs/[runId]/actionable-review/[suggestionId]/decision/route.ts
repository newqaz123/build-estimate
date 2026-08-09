import { auth } from '@/lib/auth'
import {
  ActionableReviewDecisionError,
  parseActionableReviewDecisionRequest,
  type ActionableReviewDecisionRequest,
} from '@/lib/actionable-review-decision'

export type ActionableReviewDecisionRouteContext = {
  params: Promise<{ id: string; runId: string; suggestionId: string }>
}

export type ActionableReviewDecisionResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409 | 500 | 501; body: { error: string } }

/**
 * Narrow decision dependency for Task 4 store wiring.
 * Receives only opaque path ids, the closed parsed request, and actor id.
 * Must not trust client provenance/pricing beyond the closed request shape.
 */
export interface ActionableReviewDecisionDependencies {
  authenticate(): Promise<{ user?: { id?: string | null } | null } | null>
  decide(
    boqId: string,
    runId: string,
    suggestionId: string,
    request: ActionableReviewDecisionRequest,
    actorId: string,
  ): Promise<ActionableReviewDecisionResult>
}

function validPathId(value: string): boolean {
  return value.trim() !== '' && !value.includes('/') && value.length <= 240
}

function actorId(
  session: { user?: { id?: string | null } | null } | null,
): string | null {
  const id = session?.user?.id
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null
}

/**
 * Task 3/4 seam: production persistence is added in Task 4 via
 * `decideActionableSuggestion` on the proposal store. Until then the route
 * keeps a typed unbound adapter that never mutates BOQ/catalog state.
 */
export const unboundActionableReviewDecision: ActionableReviewDecisionDependencies['decide'] =
  async () => ({
    status: 501,
    body: {
      error:
        'Actionable review decision persistence is not bound yet.',
    },
  })

export function createActionableReviewDecisionHandlers(
  dependencies: ActionableReviewDecisionDependencies,
) {
  async function POST(
    request: Request,
    context: ActionableReviewDecisionRouteContext,
  ): Promise<Response> {
    const user = actorId(await dependencies.authenticate())
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id, runId, suggestionId } = await context.params
    if (![id, runId, suggestionId].every(validPathId)) {
      return Response.json(
        { error: 'Invalid actionable review decision path' },
        { status: 400 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { error: 'Request body must be valid JSON.' },
        { status: 400 },
      )
    }

    let parsed: ActionableReviewDecisionRequest
    try {
      parsed = parseActionableReviewDecisionRequest(body)
    } catch (error) {
      if (error instanceof ActionableReviewDecisionError) {
        return Response.json({ error: error.message }, { status: 400 })
      }
      throw error
    }

    const result = await dependencies.decide(
      id,
      runId,
      suggestionId,
      parsed,
      user,
    )
    return Response.json(result.body, { status: result.status })
  }

  return { POST }
}

const handlers = createActionableReviewDecisionHandlers({
  authenticate: auth,
  decide: unboundActionableReviewDecision,
})

/**
 * Closed actionable-review decision endpoint.
 * Authenticates, parses the closed body, and delegates to the decision dependency.
 * Task 4 binds persistence; this route never trusts client provenance/pricing.
 */
export async function POST(
  request: Request,
  context: ActionableReviewDecisionRouteContext,
) {
  return handlers.POST(request, context)
}
