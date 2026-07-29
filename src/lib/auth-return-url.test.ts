import assert from "node:assert/strict"
import test from "node:test"
import { safeReviewReturnPath } from "./auth-return-url"

test("safeReviewReturnPath accepts valid internal BOQ paths with optional reviewRun query", () => {
  assert.equal(safeReviewReturnPath("/boqs/a1"), "/boqs/a1")
  assert.equal(safeReviewReturnPath("/boqs/a1?reviewRun=r1"), "/boqs/a1?reviewRun=r1")
  assert.equal(safeReviewReturnPath("/boqs/some-opaque-id-here?reviewRun=abc123"), "/boqs/some-opaque-id-here?reviewRun=abc123")
  assert.equal(safeReviewReturnPath("/boqs/test-id-with-dashes?reviewRun=run-123"), "/boqs/test-id-with-dashes?reviewRun=run-123")
})

test("safeReviewReturnPath rejects external URLs and returns /dashboard", () => {
  assert.equal(safeReviewReturnPath("https://attacker.example"), "/dashboard")
  assert.equal(safeReviewReturnPath("http://evil.com"), "/dashboard")
  assert.equal(safeReviewReturnPath("//attacker.example.com"), "/dashboard")
  assert.equal(safeReviewReturnPath("https://attacker.example.com/boqs/fake"), "/dashboard")
  assert.equal(safeReviewReturnPath("https://attacker.example.com?returnTo=/boqs/legit"), "/dashboard")
})

test("safeReviewReturnPath rejects malformed paths and returns /dashboard", () => {
  assert.equal(safeReviewReturnPath("/admin"), "/dashboard")
  assert.equal(safeReviewReturnPath("/dashboard"), "/dashboard")
  assert.equal(safeReviewReturnPath("/api/auth"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs//double-slash"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/id/trailing"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/id?other=param"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/id?reviewRun="), "/dashboard")
})

test("safeReviewReturnPath handles null and undefined gracefully", () => {
  assert.equal(safeReviewReturnPath(null), "/dashboard")
  assert.equal(safeReviewReturnPath(undefined), "/dashboard")
})

test("safeReviewReturnPath rejects URL-encoded attacks", () => {
  assert.equal(safeReviewReturnPath("/boqs/legit%2Fevil"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/legit%3FreviewRun%3Dtest"), "/dashboard")
})

test("safeReviewReturnPath rejects protocol-relative URLs", () => {
  assert.equal(safeReviewReturnPath("//example.com/boqs/fake"), "/dashboard")
  assert.equal(safeReviewReturnPath("//evil.com"), "/dashboard")
})

test("safeReviewReturnPath rejects paths with slashes in the ID", () => {
  assert.equal(safeReviewReturnPath("/boqs/id/extra"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/id/../admin"), "/dashboard")
})

test("safeReviewReturnPath rejects empty query string and malformed reviewRun", () => {
  assert.equal(safeReviewReturnPath("/boqs/id?"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/id?reviewRun"), "/dashboard")
  assert.equal(safeReviewReturnPath("/boqs/id?reviewRun=extra=params"), "/dashboard")
})

test("safeReviewReturnPath rejects non-BOQ internal paths", () => {
  assert.equal(safeReviewReturnPath("/settings"), "/dashboard")
  assert.equal(safeReviewReturnPath("/catalog"), "/dashboard")
  assert.equal(safeReviewReturnPath("/estimator"), "/dashboard")
  assert.equal(safeReviewReturnPath("/compare"), "/dashboard")
})
