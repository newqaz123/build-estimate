import assert from "node:assert/strict"
import test from "node:test"
import {
  boqComparisonReviewHref,
  boqDetailHref,
  boqDetailReturnHref,
  boqReviewHref,
  boqWorkspaceHref,
  compareBoqHref,
  isBoqReviewMode,
  safeBoqWorkspaceView,
  safeCompareReturnPath,
} from "./boq-review-route"

test("BOQ detail and legacy review helpers resolve to one canonical encoded URL", () => {
  assert.equal(boqDetailHref("boq / 7"), "/boqs/boq%20%2F%207")
  assert.equal(boqReviewHref("boq / 7"), boqDetailHref("boq / 7"))
  assert.equal(boqReviewHref("boq / 7").includes("?"), false)
})

test("compare review URLs preserve opaque BOQ ids through nested encoding", () => {
  const compareHref = compareBoqHref("boq / 7")
  const reviewHref = boqComparisonReviewHref("boq / 7")
  const parsed = new URL(reviewHref, "https://buildestimate.local")

  assert.equal(compareHref, "/compare?boq=boq+%2F+7")
  assert.equal(parsed.pathname, "/boqs/boq%20%2F%207")
  assert.equal(parsed.searchParams.get("returnTo"), compareHref)
  assert.equal(safeCompareReturnPath(parsed.searchParams.get("returnTo")), compareHref)
})

test("safe compare returns preserve leading/trailing whitespace in opaque boq ids", () => {
  const paddedId = " boq "
  const compareHref = compareBoqHref(paddedId)
  const reviewHref = boqComparisonReviewHref(paddedId)
  const parsed = new URL(reviewHref, "https://buildestimate.local")

  assert.equal(compareHref, "/compare?boq=+boq+")
  assert.equal(parsed.pathname, "/boqs/%20boq%20")
  assert.equal(parsed.searchParams.get("returnTo"), compareHref)
  assert.equal(safeCompareReturnPath(parsed.searchParams.get("returnTo")), compareHref)

  for (const value of ["/compare?boq=%20", "/compare?boq=+", "/compare?boq=%20%09%0A"]) {
    assert.equal(safeCompareReturnPath(value), null)
  }
})

test("safe compare returns accept only the compare route and one optional boq id", () => {
  assert.equal(safeCompareReturnPath("/compare"), "/compare")
  assert.equal(
    safeCompareReturnPath("/compare?boq=boq+%2F+7"),
    "/compare?boq=boq+%2F+7",
  )
  assert.equal(
    boqDetailReturnHref("boq / 7", "/compare?boq=boq+%2F+7"),
    "/boqs/boq%20%2F%207?returnTo=%2Fcompare%3Fboq%3Dboq%2B%252F%2B7",
  )
})

test("safe compare returns reject external, malformed, and unsupported destinations", () => {
  const invalidValues = [
    null,
    undefined,
    "",
    "https://attacker.example/compare?boq=1",
    "//attacker.example/compare?boq=1",
    "javascript:alert(1)",
    "/compare-extra?boq=1",
    "/compare/?boq=1",
    "/compare?",
    "/compare?boq=",
    "/compare?boq=%20",
    "/compare?boq=1&boq=2",
    "/compare?boq=1&admin=true",
    "/compare?boq=1#fragment",
    "/boqs/1",
    "/dashboard",
    "/%2e%2e/compare?boq=1",
    "/compare?boq=%E0%A4%A",
  ]

  for (const value of invalidValues) {
    assert.equal(safeCompareReturnPath(value), null)
    assert.equal(boqDetailReturnHref("boq-1", value), "/boqs/boq-1")
  }
})

test("only legacy mode=review links request one-time canonicalization", () => {
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=review")), true)
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=Review")), false)
  assert.equal(isBoqReviewMode(new URLSearchParams("review=true")), false)
})

test("workspace view accepts only review and compare", () => {
  assert.equal(safeBoqWorkspaceView("review"), "review")
  assert.equal(safeBoqWorkspaceView("compare"), "compare")
  assert.equal(safeBoqWorkspaceView("javascript:alert(1)"), "review")
  assert.equal(safeBoqWorkspaceView(null), "review")
})

test("workspace href preserves only a validated compare return path", () => {
  assert.equal(
    boqWorkspaceHref("boq/id ?#", "compare", "/compare?boq=boq%2Fid+%3F%23"),
    "/boqs/boq%2Fid%20%3F%23?view=compare&returnTo=%2Fcompare%3Fboq%3Dboq%252Fid%2B%253F%2523",
  )
  assert.equal(
    boqWorkspaceHref("opaque", "review", "https://evil.example/compare"),
    "/boqs/opaque?view=review",
  )
})
