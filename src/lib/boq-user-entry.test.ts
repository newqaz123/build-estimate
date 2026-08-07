import assert from "node:assert/strict"
import test from "node:test"
import type { Boq, BoqPricedItem, BoqSourceCosts, BoqSourceRef } from "./boq-schema"
import {
  addMissingBoqItem,
  addSourceBackedBoqItem,
  MissingBoqItemError,
  parseMissingBoqItemRequest,
  parseSourceBackedItemRequest,
  parseSourceBackedManualAddRequest,
  type ValidatedSourceMapping,
} from "./boq-user-entry"

const boq = {
  id: "boq-1", project: "Drainage", vendor: "Vendor", workType: "MEP", date: "2026-01-01", status: "draft", stdStatus: "none",
  sections: [{ header: "Drainage", items: [{ id: "existing", desc: "Gutter", unit: "m", qty: 1, rate: 10, total: 10, type: "unit", stdStatus: "unmatched" }] }],
  totalItems: 1, grandTotal: 10, createdAt: "", updatedAt: "",
} as Boq

test("missing item request creates an unpriced user-origin row without source provenance", () => {
  const request = parseMissingBoqItemRequest({ sectionIndex: 0, desc: "Missing flashing" })
  const updated = addMissingBoqItem(boq, request, "user-item-1")
  const added = updated.sections[0]?.items[1]
  assert.deepEqual(added, {
    id: "user-item-1", desc: "Missing flashing", unit: "", qty: 0, rate: 0, total: 0, type: "unit",
    pricingRole: "standard", costComponent: "combined", sourceRowIds: [], entryOrigin: "user", stdStatus: "unmatched",
  })
  assert.equal(updated.totalItems, 2)
  assert.equal(updated.grandTotal, 10)
})

test("missing items cannot be added to approved BOQs or malformed sections", () => {
  assert.throws(() => addMissingBoqItem({ ...boq, status: "approved" }, parseMissingBoqItemRequest({ sectionIndex: 0 }), "id"), /approved/i)
  assert.throws(() => parseMissingBoqItemRequest({ sectionIndex: -1 }), /sectionIndex/i)
})

const sourceRef: BoqSourceRef = { page: 1, table: 0, row: 4 }
const sourceCosts: BoqSourceCosts = {
  material: { present: true, qty: 18, unit: "m2", rate: 950, total: 17100 },
  labour: { present: true, qty: 18, unit: "m2", rate: 620, total: 11160 },
}
const sourceMapping: ValidatedSourceMapping = {
  sourceRowId: "row-mapped",
  sourceRowIds: ["row-mapped"],
  sourceRef,
  sourceCosts,
}

const sourceRequest = {
  sectionIndex: 0,
  item: { desc: "Wall installation", unit: "m2", qty: 18, materialCost: 980, labourCost: 650 },
}

test("parseSourceBackedItemRequest accepts editable user values plus section identity", () => {
  const request = parseSourceBackedItemRequest(sourceRequest)
  assert.deepEqual(request, {
    sectionIndex: 0, desc: "Wall installation", unit: "m2", qty: 18, materialCost: 980, labourCost: 650,
  })
})

test("parseSourceBackedItemRequest rejects malformed editable payloads", () => {
  const valid = sourceRequest.item
  for (const payload of [
    { sectionIndex: -1, item: valid },
    { sectionIndex: 0.5, item: valid },
    { sectionIndex: 0 },
    { sectionIndex: 0, item: null },
    { sectionIndex: 0, item: { ...valid, desc: "" } },
    { sectionIndex: 0, item: { ...valid, desc: "   " } },
    { sectionIndex: 0, item: { ...valid, unit: "" } },
    { sectionIndex: 0, item: { ...valid, qty: -1 } },
    { sectionIndex: 0, item: { ...valid, qty: Number.POSITIVE_INFINITY } },
    { sectionIndex: 0, item: { ...valid, materialCost: -5 } },
    { sectionIndex: 0, item: { ...valid, labourCost: Number.NaN } },
    { sectionIndex: 0, item: { ...valid, materialCost: 12.345 } },
    { sectionIndex: 0, item: { ...valid, labourCost: 0.001 } },
    { sectionIndex: 0, item: { ...valid, extra: "ignored" } },
    { sectionIndex: 0, item: valid, sourceRowId: "client-supplied" },
    null,
    "not-an-object",
  ]) {
    assert.throws(() => parseSourceBackedItemRequest(payload), MissingBoqItemError)
  }
})

test("addSourceBackedBoqItem writes a user-origin item with source provenance and manual allocation", () => {
  const request = parseSourceBackedItemRequest(sourceRequest)
  const result = addSourceBackedBoqItem({ boq, validatedSourceMapping: sourceMapping, userValues: request, itemId: "user-item-1" })
  const added = result.boq.sections[0]?.items.at(-1)
  assert.deepEqual(added, {
    id: "user-item-1",
    desc: "Wall installation",
    unit: "m2",
    qty: 18,
    rate: 1630,
    total: 29340,
    type: "unit",
    pricingRole: "standard",
    costComponent: "combined",
    entryOrigin: "user",
    sourceRowId: "row-mapped",
    sourceRowIds: ["row-mapped"],
    sourceRef,
    sourceCosts,
    costAllocation: { basis: "rate", material: 980, labour: 650, origin: "manual" },
    stdStatus: "unmatched",
  })
  assert.equal(result.item.id, "user-item-1")
  assert.equal(result.boq.totalItems, 2)
  assert.equal(result.boq.grandTotal, 29350)
  assert.equal(result.boq.stdStatus, "none")
})

test("addSourceBackedBoqItem omits sourceRef/sourceCosts when the mapping carries no component cells", () => {
  const request = parseSourceBackedItemRequest({
    sectionIndex: 0,
    item: { desc: "Trench dig", unit: "m", qty: 1, materialCost: 100, labourCost: 50 },
  })
  const result = addSourceBackedBoqItem({
    boq,
    validatedSourceMapping: { sourceRowId: "row-a", sourceRowIds: ["row-a", "row-b"] },
    userValues: request,
    itemId: "user-2",
  })
  const added = result.boq.sections[0]?.items.at(-1) as BoqPricedItem | undefined
  assert.equal(added?.sourceRowId, "row-a")
  assert.deepEqual(added?.sourceRowIds, ["row-a", "row-b"])
  assert.equal(added && "sourceRef" in added, false)
  assert.equal(added && "sourceCosts" in added, false)
  assert.equal(added?.costAllocation?.origin, "manual")
})

test("addSourceBackedBoqItem flips a complete BOQ to partial and rejects approved or invalid destinations", () => {
  const request = parseSourceBackedItemRequest({
    sectionIndex: 0,
    item: { desc: "Wall", unit: "m2", qty: 1, materialCost: 100, labourCost: 50 },
  })
  const completeBoq = { ...boq, stdStatus: "complete" as const }
  const flipped = addSourceBackedBoqItem({ boq: completeBoq, validatedSourceMapping: sourceMapping, userValues: request, itemId: "user-3" })
  assert.equal(flipped.boq.stdStatus, "partial")

  assert.throws(
    () => addSourceBackedBoqItem({ boq: { ...boq, status: "approved" }, validatedSourceMapping: sourceMapping, userValues: request, itemId: "user-4" }),
    /approved/i,
  )
  assert.throws(
    () => addSourceBackedBoqItem({ boq, validatedSourceMapping: sourceMapping, userValues: { ...request, sectionIndex: 99 }, itemId: "user-5" }),
    /section/i,
  )
  assert.throws(
    () => addSourceBackedBoqItem({ boq, validatedSourceMapping: sourceMapping, userValues: request, itemId: "   " }),
    /id/i,
  )
})

test("addSourceBackedBoqItem rejects non-finite component values that escape the parser", () => {
  const request = parseSourceBackedItemRequest({
    sectionIndex: 0,
    item: { desc: "Wall", unit: "m2", qty: 1, materialCost: 100, labourCost: 50 },
  })
  assert.throws(
    () => addSourceBackedBoqItem({
      boq,
      validatedSourceMapping: sourceMapping,
      userValues: { ...request, materialCost: Number.NaN },
      itemId: "user-6",
    }),
    MissingBoqItemError,
  )
})

const manualSingleBody = {
  sectionIndex: 0,
  item: { desc: "Tooling", unit: "Lot", qty: 1, materialCost: 6000, labourCost: 0 },
}

const validAddDecision = {
  sourceRowId: "row-1",
  action: "add",
  sectionIndex: 0,
  item: { desc: "Tooling", unit: "Lot", qty: 1, materialCost: 6000, labourCost: 0 },
}

const validIgnoreDecision = {
  sourceRowId: "row-2",
  action: "ignore",
  note: "Already represented",
}

test("parseSourceBackedManualAddRequest parses a single source-backed request", () => {
  assert.deepEqual(parseSourceBackedManualAddRequest(manualSingleBody), {
    mode: "single",
    value: { sectionIndex: 0, desc: "Tooling", unit: "Lot", qty: 1, materialCost: 6000, labourCost: 0 },
  })
})

test("parseSourceBackedManualAddRequest parses a mixed decision-batch request", () => {
  const result = parseSourceBackedManualAddRequest({ decisions: [validAddDecision, validIgnoreDecision] })
  assert.equal(result.mode, "decision_batch")
  if (result.mode !== "decision_batch") return
  assert.equal(result.decisions.length, 2)
  assert.deepEqual(result.decisions[0], {
    sourceRowId: "row-1",
    action: "add",
    item: { sectionIndex: 0, desc: "Tooling", unit: "Lot", qty: 1, materialCost: 6000, labourCost: 0 },
  })
  assert.deepEqual(result.decisions[1], { sourceRowId: "row-2", action: "ignore", note: "Already represented" })
})

test("parseSourceBackedManualAddRequest parses an add-only decision batch", () => {
  const result = parseSourceBackedManualAddRequest({ decisions: [
    { ...validAddDecision, sourceRowId: "row-a" },
    { ...validAddDecision, sourceRowId: "row-b" },
  ] })
  assert.equal(result.mode, "decision_batch")
  if (result.mode !== "decision_batch") return
  assert.equal(result.decisions.every((d) => d.action === "add"), true)
})

test("parseSourceBackedManualAddRequest parses an ignore-only decision batch and omits blank notes", () => {
  const result = parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-a", action: "ignore", note: "   " },
    { sourceRowId: "row-b", action: "ignore" },
  ] })
  assert.equal(result.mode, "decision_batch")
  if (result.mode !== "decision_batch") return
  assert.equal(result.decisions.length, 2)
  for (const decision of result.decisions) {
    if (decision.action === "ignore") assert.equal("note" in decision && decision.note !== undefined ? false : true, true)
  }
})

test("parseSourceBackedManualAddRequest trims ignore notes", () => {
  const result = parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "ignore", note: "  Already represented  " },
  ] })
  assert.equal(result.mode, "decision_batch")
  if (result.mode !== "decision_batch" || result.decisions[0]?.action !== "ignore") return
  assert.equal(result.decisions[0].note, "Already represented")
})

test("parseSourceBackedManualAddRequest preserves client order in decision batches", () => {
  const result = parseSourceBackedManualAddRequest({ decisions: [
    { ...validAddDecision, sourceRowId: "z-row" },
    { ...validAddDecision, sourceRowId: "a-row" },
  ] })
  assert.equal(result.mode, "decision_batch")
  if (result.mode !== "decision_batch") return
  assert.equal(result.decisions[0]?.sourceRowId ?? result.decisions[0], "z-row")
})

test("parseSourceBackedManualAddRequest rejects malformed single payloads via the single parser", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ ...manualSingleBody, extra: "unknown" }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ sectionIndex: -1, item: manualSingleBody.item }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest(null), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest("not-an-object"), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects the obsolete items batch shape", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ items: [validAddDecision] }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects malformed decision-batch payloads", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: "not-an-array" }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: null }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: undefined }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [], extra: "unknown" }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects duplicate and blank sourceRowId in decisions", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { ...validAddDecision, sourceRowId: "row-1" },
    { ...validAddDecision, sourceRowId: "row-1" },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "  ", action: "ignore" },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: 5, action: "ignore" },
  ] }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects invalid action discriminators", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "delete" },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: null },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1" },
  ] }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects add decisions missing sectionIndex or item", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "add", item: validAddDecision.item },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "add", sectionIndex: 0 },
  ] }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects add decisions carrying a note", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { ...validAddDecision, note: "should not be here" },
  ] }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects ignore decisions carrying sectionIndex or item", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "ignore", sectionIndex: 0 },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "ignore", item: validAddDecision.item },
  ] }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects non-string and overlong notes", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "ignore", note: 42 },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "ignore", note: "x".repeat(501) },
  ] }), MissingBoqItemError)
  assert.doesNotThrow(() => parseSourceBackedManualAddRequest({ decisions: [
    { sourceRowId: "row-1", action: "ignore", note: "x".repeat(500) },
  ] }))
})

test("parseSourceBackedManualAddRequest rejects unknown decision entry keys", () => {
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    { ...validAddDecision, extra: "unknown" },
  ] }), MissingBoqItemError)
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: [
    "not-an-object",
  ] }), MissingBoqItemError)
})

test("parseSourceBackedManualAddRequest rejects decision batches larger than 100 entries", () => {
  const tooMany = Array.from({ length: 101 }, (_, index) => ({
    sourceRowId: `row-${index}`, action: "ignore" as const,
  }))
  assert.throws(() => parseSourceBackedManualAddRequest({ decisions: tooMany }), MissingBoqItemError)
  const atLimit = Array.from({ length: 100 }, (_, index) => ({
    sourceRowId: `row-${index}`, action: "ignore" as const,
  }))
  assert.doesNotThrow(() => parseSourceBackedManualAddRequest({ decisions: atLimit }))
})
