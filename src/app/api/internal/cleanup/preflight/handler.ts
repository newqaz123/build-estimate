import { timingSafeEqual } from 'node:crypto'

export interface PreflightCleanupHandlerDependencies {
  secret: string
  cleanup: () => Promise<number>
}

/**
 * Factory for creating the preflight cleanup handler with fail-closed secret validation.
 * When secret is empty, rejects all requests as a security measure.
 */
export function createPreflightCleanupHandler(
  dependencies: PreflightCleanupHandlerDependencies,
): { DELETE: (request: Request) => Promise<Response> } {
  const { secret, cleanup } = dependencies

  async function DELETE(request: Request): Promise<Response> {
    // FAIL-CLOSED: Reject all requests when secret is not configured
    if (!secret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const providedSecret = request.headers.get('x-cleanup-secret')
    if (!providedSecret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Use timing-safe comparison to prevent timing attacks
    if (!preflightCleanupSecretMatches(secret, providedSecret)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
      const deleted = await cleanup()
      return Response.json({ deleted }, { status: 200 })
    } catch (error) {
      console.error('Preflight cleanup failed:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  return { DELETE }
}

/**
 * Exported for testing: uses timing-safe comparison to validate the cleanup secret.
 * This prevents timing attacks by ensuring comparison time is independent of input.
 */
export function preflightCleanupSecretMatches(expected: string, actual: string): boolean {
  if (typeof expected !== 'string' || typeof actual !== 'string') {
    return false
  }

  // Use timing-safe comparison with fixed-length buffers
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)

  if (expectedBuffer.length !== actualBuffer.length) {
    return false
  }

  return timingSafeEqual(expectedBuffer, actualBuffer)
}
