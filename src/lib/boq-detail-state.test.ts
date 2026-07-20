import assert from "node:assert/strict"
import test from "node:test"
import { reconcileBoqMutation } from "./boq-detail-state"
import { isPricedBoqItem } from "./boq-pricing"
import type { Boq, BoqPricedItem } from "./boq-schema"

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return {
    code: "DUP",
    desc: "Source item",
    unit: "m",
    qty: 1,
    rate: 10,
    total: 10,
    type: "unit",
    stdStatus: "unmatched",
    ...overrides,
  }
}

function boq(itemsBySection: BoqPricedItem[][], overrides: Partial<Boq> = {}): Boq {
  const sections = itemsBySection.map((items, index) => ({ header: `Section ${index + 1}`, items }))
  return {
    id: "boq-1",
    project: "Project",
    vendor: "Vendor",
    workType: "MEP",
    date: "2026-07-19",
    totalItems: sections.reduce((total, section) => total + section.items.length, 0),
    grandTotal: sections.reduce((total, section) => total + section.items.reduce((sum, row) => sum + row.total, 0), 0),
    status: "review",
    stdStatus: "partial",
    sections,
    sourceFileName: "legacy.pdf",
    sourceAvailable: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  }
}

test("BOQ detail exposes one mutation reconciliation boundary", () => {
  assert.equal(typeof reconcileBoqMutation, "function")
})

test("mutation responses retain an explicit no-source state when the raw BOQ omits it", () => {
  const previous = boq([[item()]])
  const incoming = { ...previous }
  delete incoming.sourceAvailable

  const result = reconcileBoqMutation(previous, incoming, {})

  assert.equal(result.boq.sourceAvailable, false)
  assert.equal(result.boq.sourceFileName, "legacy.pdf")
})

test("an explicit source availability response remains authoritative", () => {
  const previous = boq([[item()]])
  const incoming = { ...previous, sourceAvailable: true }

  assert.equal(reconcileBoqMutation(previous, incoming, {}).boq.sourceAvailable, true)
})

test("matching clears only that section-scoped row's stale description and unit edits", () => {
  const previous = boq([
    [item({ desc: "Source A" })],
    [item({ desc: "Source B" })],
  ])
  const incoming = boq([
    [item({
      desc: "Canonical A",
      unit: "pcs",
      stdStatus: "matched",
      stdId: "std-a",
      stdMatch: "Canonical A",
      stdConfidence: "manual",
    })],
    [item({ desc: "Source B" })],
  ])
  delete incoming.sourceAvailable
  const edits = {
    "0-0": { desc: "Stale A", unit: "stale-unit", qty: 12, materialCost: 15 },
    "1-0": { desc: "Keep B", unit: "kg", qty: 7 },
  }

  const result = reconcileBoqMutation(previous, incoming, edits)

  assert.equal(result.boq.sections[0]?.items[0]?.desc, "Canonical A")
  const matched = result.boq.sections[0]?.items[0]
  assert.ok(matched && isPricedBoqItem(matched))
  assert.equal(matched.unit, "pcs")
  assert.deepEqual(result.edits["0-0"], { qty: 12, materialCost: 15 })
  assert.deepEqual(result.edits["1-0"], edits["1-0"])
  assert.equal(result.boq.sourceAvailable, false)
})

test("changing an existing manual match clears stale canonical edits but retains costs", () => {
  const previous = boq([[item({
    desc: "Canonical Old",
    stdStatus: "matched",
    stdId: "std-old",
    stdMatch: "Canonical Old",
    stdConfidence: "manual",
  })]])
  const incoming = boq([[item({
    desc: "Canonical New",
    unit: "kg",
    stdStatus: "matched",
    stdId: "std-new",
    stdMatch: "Canonical New",
    stdConfidence: "manual",
  })]])

  const result = reconcileBoqMutation(previous, incoming, {
    "0-0": { desc: "Stale manual name", unit: "stale-unit", labourCost: 25 },
  })

  assert.deepEqual(result.edits["0-0"], { labourCost: 25 })
})
