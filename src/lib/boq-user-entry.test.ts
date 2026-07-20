import assert from "node:assert/strict"
import test from "node:test"
import type { Boq } from "./boq-schema"
import { addMissingBoqItem, parseMissingBoqItemRequest } from "./boq-user-entry"

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
