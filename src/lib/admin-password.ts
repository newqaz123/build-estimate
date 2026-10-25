import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time check of a submitted password against the configured
 * ADMIN_PASSWORD. Fails closed: an unset/empty configured password, or a
 * missing/non-string/empty submission, never authenticates.
 */
export function verifyAdminPassword(
  submitted: unknown,
  configured: string | undefined = process.env.ADMIN_PASSWORD,
): boolean {
  if (typeof configured !== 'string' || configured.length === 0) return false
  if (typeof submitted !== 'string' || submitted.length === 0) return false

  // Hash both sides to fixed-length digests so timingSafeEqual never throws on
  // a length mismatch and the comparison time does not leak the length.
  const a = createHash('sha256').update(submitted, 'utf8').digest()
  const b = createHash('sha256').update(configured, 'utf8').digest()
  return timingSafeEqual(a, b)
}
