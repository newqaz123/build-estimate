export type AuthorizationDecision = 'allow' | 'login-redirect' | 'api-unauthorized'

/**
 * What the auth proxy does with a request. Signed-out API calls get a JSON 401
 * (callers check `response.status === 401`) instead of a redirect to the HTML
 * login page, which fetch() would follow and report as 200.
 */
export function authorizationDecision(isLoggedIn: boolean, pathname: string): AuthorizationDecision {
  if (pathname === '/' || pathname.startsWith('/api/auth')) return 'allow'
  if (isLoggedIn) return 'allow'
  return pathname === '/api' || pathname.startsWith('/api/') ? 'api-unauthorized' : 'login-redirect'
}
