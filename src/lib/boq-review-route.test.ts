import assert from "node:assert/strict"
import test from "node:test"
import { boqDetailHref, boqReviewHref, isBoqReviewMode } from "./boq-review-route"

test("BOQ detail and legacy review helpers resolve to one canonical encoded URL", () => {
  assert.equal(boqDetailHref("boq / 7"), "/boqs/boq%20%2F%207")
  assert.equal(boqReviewHref("boq / 7"), boqDetailHref("boq / 7"))
  assert.equal(boqReviewHref("boq / 7").includes("?"), false)
})

test("only legacy mode=review links request one-time canonicalization", () => {
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=review")), true)
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=Review")), false)
  assert.equal(isBoqReviewMode(new URLSearchParams("review=true")), false)
})
