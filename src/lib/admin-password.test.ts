import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyAdminPassword } from './admin-password'

test('verifyAdminPassword accepts the exact configured password', () => {
  assert.equal(verifyAdminPassword('s3cret-pass', 's3cret-pass'), true)
})

test('verifyAdminPassword rejects a wrong password of the same length', () => {
  assert.equal(verifyAdminPassword('s3cret-pasx', 's3cret-pass'), false)
})

test('verifyAdminPassword rejects a wrong password of a different length without throwing', () => {
  assert.equal(verifyAdminPassword('short', 's3cret-pass'), false)
  assert.equal(verifyAdminPassword('s3cret-pass-but-longer', 's3cret-pass'), false)
})

test('verifyAdminPassword rejects everything when ADMIN_PASSWORD is unset or empty', () => {
  assert.equal(verifyAdminPassword(undefined, undefined), false)
  assert.equal(verifyAdminPassword('', undefined), false)
  assert.equal(verifyAdminPassword('', ''), false)
  assert.equal(verifyAdminPassword('anything', ''), false)
  assert.equal(verifyAdminPassword('anything', undefined), false)
})

test('verifyAdminPassword rejects missing, empty, or non-string submissions', () => {
  for (const submitted of [undefined, null, '', 0, 123, true, {}, ['s3cret-pass']]) {
    assert.equal(verifyAdminPassword(submitted, 's3cret-pass'), false, `submitted=${JSON.stringify(submitted)}`)
  }
})

test('verifyAdminPassword is case- and whitespace-sensitive', () => {
  assert.equal(verifyAdminPassword('S3CRET-PASS', 's3cret-pass'), false)
  assert.equal(verifyAdminPassword(' s3cret-pass', 's3cret-pass'), false)
})

test('verifyAdminPassword reads process.env.ADMIN_PASSWORD by default', () => {
  const previous = process.env.ADMIN_PASSWORD
  try {
    delete process.env.ADMIN_PASSWORD
    assert.equal(verifyAdminPassword(undefined), false)
    process.env.ADMIN_PASSWORD = 'env-pass'
    assert.equal(verifyAdminPassword('env-pass'), true)
    assert.equal(verifyAdminPassword('nope'), false)
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD
    else process.env.ADMIN_PASSWORD = previous
  }
})
