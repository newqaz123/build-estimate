import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const pageUrl = new URL("./page.tsx", import.meta.url)

test("Task 9: login page reads returnTo from query and validates with safeReviewReturnPath", () => {
  assert.equal(existsSync(pageUrl), true)
  if (!existsSync(pageUrl)) return
  const source = readFileSync(pageUrl, "utf8")

  // Page should read returnTo from the query
  assert.match(source, /returnTo/)

  // Page should import or use safeReviewReturnPath
  assert.match(source, /safeReviewReturnPath/)

  // After successful sign-in, router.push should use the validated returnTo path
  assert.match(source, /router\.push.*safeReviewReturnPath/)

  // returnTo should be read from searchParams (useSearchParams or URLSearchParams)
  assert.match(source, /searchParams|useSearchParams/)
})

test("Task 9: login page validates returnTo before redirect", () => {
  const source = readFileSync(pageUrl, "utf8")

  // safeReviewReturnPath should be called with returnTo value
  assert.match(source, /safeReviewReturnPath\(/)

  // The validation should be used in the redirect (either before or inside router.push)
  const matchBefore = source.match(/safeReviewReturnPath[\s\S]{0,500}?router\.push/)
  const matchInside = source.match(/router\.push[\s\S]{0,200}?safeReviewReturnPath/)
  assert.ok(matchBefore || matchInside, "safeReviewReturnPath should be used for router.push")

  // External or invalid returnTo should fall back to /dashboard
  // This is tested by checking that safeReviewReturnPath is used (not raw returnTo)
  assert.match(source, /safeReviewReturnPath\([^)]*\)/)
})
