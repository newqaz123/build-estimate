import assert from "node:assert/strict"
import test from "node:test"
import {
  applyBoqDetailEdits,
  clearBoqDetailDraftSnapshot,
  compareBoqUpdatedAt,
  reconcileBoqMutation,
  restoreBoqDetailDraft,
  takeBoqDetailDraft,
} from "./boq-detail-state"
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
    [item({ id: "a", desc: "Source A" })],
    [item({ id: "b", desc: "Source B" })],
  ])
  const incoming = boq([
    [
      item({ id: "inserted", code: "INSERTED" }),
      item({
        id: "a",
        desc: "Canonical A",
        unit: "pcs",
        stdStatus: "matched",
        stdId: "std-a",
        stdMatch: "Canonical A",
        stdConfidence: "manual",
      }),
    ],
    [item({ id: "b", desc: "Source B" })],
  ])
  delete incoming.sourceAvailable
  const edits = {
    "id:a": { desc: "Stale A", unit: "stale-unit", qty: 12, materialCost: 15 },
    "id:b": { desc: "Keep B", unit: "kg", qty: 7 },
  }

  const result = reconcileBoqMutation(previous, incoming, edits)

  assert.equal(result.boq.sections[0]?.items[1]?.desc, "Canonical A")
  const matched = result.boq.sections[0]?.items[1]
  assert.ok(matched && isPricedBoqItem(matched))
  assert.equal(matched.unit, "pcs")
  assert.deepEqual(result.edits["id:a"], { qty: 12, materialCost: 15 })
  assert.deepEqual(result.edits["id:b"], edits["id:b"])
  assert.deepEqual(result.issues, [])
  assert.equal(result.boq.sourceAvailable, false)
})

test("changing an existing manual match clears stale canonical edits but retains costs", () => {
  const previous = boq([[item({
    id: "a",
    desc: "Canonical Old",
    stdStatus: "matched",
    stdId: "std-old",
    stdMatch: "Canonical Old",
    stdConfidence: "manual",
  })]])
  const incoming = boq([[item({
    id: "a",
    desc: "Canonical New",
    unit: "kg",
    stdStatus: "matched",
    stdId: "std-new",
    stdMatch: "Canonical New",
    stdConfidence: "manual",
  })]])

  const result = reconcileBoqMutation(previous, incoming, {
    "id:a": { desc: "Stale manual name", unit: "stale-unit", labourCost: 25 },
  })

  assert.deepEqual(result.edits["id:a"], { labourCost: 25 })
})

test("drafts stay attached to identity after insertion and section pruning", () => {
  const edits = {
    "id:target": { desc: "Local target", qty: 7 },
  }
  const incoming = boq([
    [item({ id: "inserted", code: "INSERTED" })],
    [item({ id: "target", code: "TARGET" })],
  ])

  const result = applyBoqDetailEdits(incoming, edits)
  assert.deepEqual(result.issues, [])
  assert.equal(result.boq.sections[1]!.items[0]!.desc, "Local target")
  const edited = result.boq.sections[1]!.items[0]!
  assert.ok(isPricedBoqItem(edited))
  assert.equal(edited.qty, 7)
  assert.equal(result.boq.sections[0]!.items[0]!.desc, "Source item")
})

test("ambiguous identities are not applied to either row", () => {
  const source = boq([
    [item({ id: undefined, code: "DUP", desc: "First" })],
    [item({ id: undefined, code: "DUP", desc: "Second" })],
  ])

  const result = applyBoqDetailEdits(source, {
    "code:DUP": { desc: "Unsafe edit" },
  })

  assert.deepEqual(result.issues, [{
    identityKey: "code:DUP",
    status: "ambiguous",
  }])
  assert.equal(result.boq.sections[0]!.items[0]!.desc, "First")
  assert.equal(result.boq.sections[1]!.items[0]!.desc, "Second")
})

test("delete staging removes and restores only the selected draft", () => {
  const original = {
    "id:first": { qty: 2 },
    "id:second": { desc: "Keep me" },
  }
  const taken = takeBoqDetailDraft(original, "id:first")

  assert.deepEqual(taken.edits, {
    "id:second": { desc: "Keep me" },
  })
  assert.deepEqual(
    restoreBoqDetailDraft(taken.edits, "id:first", taken.draft),
    original,
  )
})

test("clearing a saved snapshot preserves drafts restored or created after capture", () => {
  // After a successful Save, only the captured snapshot drafts should be cleared.
  // A draft restored by an Undo during the in-flight Save (a key absent from the
  // snapshot) must survive the success boundary intact.
  const snapshot = { "id:A": { desc: "a" } }
  const restoredDuringSave = {
    "id:A": { desc: "a" },
    "code:B": { qty: 2 },
  }
  assert.deepEqual(clearBoqDetailDraftSnapshot(restoredDuringSave, snapshot), {
    "code:B": { qty: 2 },
  })
  // An empty snapshot clears nothing.
  assert.deepEqual(
    clearBoqDetailDraftSnapshot(restoredDuringSave, {}),
    restoredDuringSave,
  )
  // Unrelated drafts across many sections are all preserved.
  assert.deepEqual(
    clearBoqDetailDraftSnapshot(
      { "id:A": { desc: "a" }, "id:C": { rate: 5 }, "code:B": { qty: 2 } },
      { "id:A": { desc: "a" } },
    ),
    { "id:C": { rate: 5 }, "code:B": { qty: 2 } },
  )
})

test("orders canonical responses by updatedAt and rejects invalid revisions", () => {
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: "2026-07-30T10:00:00.000Z" },
      { updatedAt: "2026-07-30T10:00:01.000Z" },
    ),
    "incoming-newer",
  )
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: "2026-07-30T10:00:01.000Z" },
      { updatedAt: "2026-07-30T10:00:00.000Z" },
    ),
    "incoming-older",
  )
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: "2026-07-30T10:00:00.000Z" },
      { updatedAt: "2026-07-30T10:00:00.000Z" },
    ),
    "equal",
  )
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: "invalid" },
      { updatedAt: "2026-07-30T10:00:00.000Z" },
    ),
    "invalid",
  )
})
