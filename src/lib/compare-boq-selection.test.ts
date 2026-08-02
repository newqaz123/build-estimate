import assert from "node:assert/strict"
import test from "node:test"
import { resolveCompareBoqId } from "./compare-boq-selection"

const boqs = [{ id: "first" }, { id: "preferred" }, { id: "current" }]

test("query selection wins when the requested BOQ exists", () => {
  assert.equal(
    resolveCompareBoqId(boqs, "preferred", "current"),
    "preferred",
  )
})

test("an unknown query retains a current selection that still exists", () => {
  assert.equal(
    resolveCompareBoqId(boqs, "missing", "current"),
    "current",
  )
})

test("an unknown query falls back to the first BOQ when current is stale", () => {
  assert.equal(
    resolveCompareBoqId(boqs, "missing", "removed"),
    "first",
  )
})

test("a removed current BOQ falls back safely without a query", () => {
  assert.equal(resolveCompareBoqId(boqs, null, "removed"), "first")
})

test("an empty BOQ list resolves to no selection", () => {
  assert.equal(resolveCompareBoqId([], "missing", "current"), "")
})
