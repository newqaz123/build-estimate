export type AuthorizationDecision = 'allow' | 'login-redirect' | 'api-unauthorized'

/**
 * API paths that skip the login check because the route itself demands a secret
 * (machine-to-machine callers such as the cleanup cron have no session).
 * Exact matches only — nothing under or beside these paths is opened.
 */
export const SECRET_PROTECTED_API_PATHS: readonly string[] = ['/api/internal/cleanup/preflight']

/**
 * What the auth proxy does with a request. Signed-out API calls get a JSON 401
 * (callers check `response.status === 401`) instead of a redirect to the HTML
 * login page, which fetch() would follow and report as 200.
 */
export function authorizationDecision(isLoggedIn: boolean, pathname: string): AuthorizationDecision {
  if (pathname === '/' || pathname.startsWith('/api/auth')) return 'allow'
  if (SECRET_PROTECTED_API_PATHS.includes(pathname)) return 'allow'
  if (isLoggedIn) return 'allow'
  return pathname === '/api' || pathname.startsWith('/api/') ? 'api-unauthorized' : 'login-redirect'
}
