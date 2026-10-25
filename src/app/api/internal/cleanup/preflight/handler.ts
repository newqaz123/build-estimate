import { createHash, timingSafeEqual } from 'node:crypto'

export interface PreflightCleanupHandlerDependencies {
  /** CLEANUP_SERVER_SECRET, sent by ops scripts as the `x-cleanup-secret` header (DELETE only). */
  secret: string
  /** CRON_SECRET, sent by the scheduler as `Authorization: Bearer <secret>` (GET or DELETE). */
  cronSecret?: string
  cleanup: () => Promise<number>
}

const UNAUTHORIZED = () => Response.json({ error: 'Unauthorized' }, { status: 401 })

/** The proxy lets this one path through without a login; the handler checks its own secret. */
export const PREFLIGHT_CLEANUP_PATH = '/api/internal/cleanup/preflight'

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

/**
 * Fail-closed cleanup endpoint. A request is accepted only when it carries a
 * secret that is configured on the server; an unset secret accepts nothing.
 */
export function createPreflightCleanupHandler(
  dependencies: PreflightCleanupHandlerDependencies,
): { GET: (request: Request) => Promise<Response>; DELETE: (request: Request) => Promise<Response> } {
  const { secret, cronSecret = '', cleanup } = dependencies

  function authorized(request: Request, allowHeaderSecret: boolean): boolean {
    const bearer = bearerToken(request)
    if (bearer !== null) {
      return Boolean(cronSecret) && preflightCleanupSecretMatches(cronSecret, bearer)
    }
    if (!allowHeaderSecret) return false
    const provided = request.headers.get('x-cleanup-secret')
    return Boolean(secret) && provided !== null && preflightCleanupSecretMatches(secret, provided)
  }

  async function run(): Promise<Response> {
    try {
      const deleted = await cleanup()
      return Response.json({ deleted }, { status: 200 })
    } catch (error) {
      console.error('Preflight cleanup failed:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // Schedulers such as Vercel Cron call with GET + Authorization: Bearer <CRON_SECRET>.
  async function GET(request: Request): Promise<Response> {
    if (!authorized(request, false)) return UNAUTHORIZED()
    return run()
  }

  async function DELETE(request: Request): Promise<Response> {
    if (!authorized(request, true)) return UNAUTHORIZED()
    return run()
  }

  return { GET, DELETE }
}

/**
 * Constant-time secret comparison. Both sides are hashed first so neither the
 * content nor the length of the expected secret leaks through timing.
 */
export function preflightCleanupSecretMatches(expected: string, actual: string): boolean {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected === '') {
    return false
  }
  const expectedDigest = createHash('sha256').update(expected).digest()
  const actualDigest = createHash('sha256').update(actual).digest()
  return timingSafeEqual(expectedDigest, actualDigest)
}
