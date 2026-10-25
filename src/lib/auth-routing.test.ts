import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizationDecision } from './auth-routing'

test('signed-out API calls get a 401 decision, pages a login redirect, public paths pass', () => {
  assert.equal(authorizationDecision(false, '/api/boqs'), 'api-unauthorized')
  assert.equal(authorizationDecision(false, '/api/internal/cleanup/preflight'), 'api-unauthorized')
  assert.equal(authorizationDecision(false, '/boqs'), 'login-redirect')
  assert.equal(authorizationDecision(false, '/apiary'), 'login-redirect')
  assert.equal(authorizationDecision(false, '/'), 'allow')
  assert.equal(authorizationDecision(false, '/api/auth/session'), 'allow')
  assert.equal(authorizationDecision(true, '/api/boqs'), 'allow')
  assert.equal(authorizationDecision(true, '/boqs'), 'allow')
})
