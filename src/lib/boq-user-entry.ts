import { calculateBoqTotals } from "./boq-pricing"
import { applyManualCostAllocation, costAllocationReconciles } from "./boq-cost-allocation"
import type { Boq, BoqPricedItem, BoqSourceCost, BoqSourceCosts, BoqSourceRef } from "./boq-schema"

export interface MissingBoqItemRequest {
  sectionIndex: number
  desc: string
}

export class MissingBoqItemError extends TypeError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseMissingBoqItemRequest(value: unknown): MissingBoqItemRequest {
  if (!isRecord(value)) throw new MissingBoqItemError("Request body must be an object.")
  if (!Number.isInteger(value.sectionIndex) || Number(value.sectionIndex) < 0) throw new MissingBoqItemError("sectionIndex must be a non-negative integer.")
  if (value.desc !== undefined && (typeof value.desc !== "string" || !value.desc.trim() || value.desc.length > 500)) {
    throw new MissingBoqItemError("desc must be a non-empty description.")
  }
  return { sectionIndex: Number(value.sectionIndex), desc: typeof value.desc === "string" ? value.desc.trim() : "New missing item" }
}

export function addMissingBoqItem(boq: Boq, request: MissingBoqItemRequest, itemId: string): Boq {
  if (boq.status === "approved") throw new MissingBoqItemError("Approved BOQs are read-only.")
  if (!itemId.trim()) throw new MissingBoqItemError("A stable item ID is required.")
  if (!boq.sections[request.sectionIndex]) throw new MissingBoqItemError("sectionIndex does not exist.")
  const item: BoqPricedItem = {
    id: itemId,
    desc: request.desc,
    unit: "",
    qty: 0,
    rate: 0,
    total: 0,
    type: "unit",
    pricingRole: "standard",
    costComponent: "combined",
    sourceRowIds: [],
    entryOrigin: "user",
    stdStatus: "unmatched",
  }
  const sections = boq.sections.map((section, index) => index === request.sectionIndex ? { ...section, items: [...section.items, item] } : section)
  return { ...boq, sections, ...calculateBoqTotals(sections), stdStatus: boq.stdStatus === "complete" ? "partial" : boq.stdStatus }
}

/** Editable user values for a source-backed manual correction. The client never
 *  supplies provenance (sourceRowId/sourceRef/sourceCosts) — those are resolved
 *  server-side from the immutable review draft. */
export interface SourceBackedItemRequest {
  sectionIndex: number
  desc: string
  unit: string
  qty: number
  materialCost: number
  labourCost: number
}

const SOURCE_ITEM_KEYS = new Set(["desc", "unit", "qty", "materialCost", "labourCost"])
const SOURCE_REQUEST_KEYS = new Set(["sectionIndex", "item"])
const COMPONENT_FIELDS: ReadonlyArray<keyof Pick<SourceBackedItemRequest, "materialCost" | "labourCost">> = ["materialCost", "labourCost"]

function requireFiniteNonNegative(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MissingBoqItemError(`${field} must be a finite non-negative number.`)
  }
  return value
}

function requireCentsPrecision(field: string, value: number): void {
  const scaled = Math.round(value * 100)
  if (Math.abs(scaled / 100 - value) > 1e-9) {
    throw new MissingBoqItemError(`${field} must have at most 2 decimal places.`)
  }
}

/** Parse only the editable user values. Provenance is intentionally absent: the
 *  server reconstructs it from the immutable review draft inside the transaction. */
export function parseSourceBackedItemRequest(value: unknown): SourceBackedItemRequest {
  if (!isRecord(value)) throw new MissingBoqItemError("Request body must be an object.")
  if (!Number.isInteger(value.sectionIndex) || Number(value.sectionIndex) < 0) {
    throw new MissingBoqItemError("sectionIndex must be a non-negative integer.")
  }
  for (const key of Object.keys(value)) {
    if (!SOURCE_REQUEST_KEYS.has(key)) throw new MissingBoqItemError(`Unexpected request field: ${key}.`)
  }
  const item = value.item
  if (!isRecord(item)) throw new MissingBoqItemError("item must be an object with editable values.")
  for (const key of Object.keys(item)) {
    if (!SOURCE_ITEM_KEYS.has(key)) throw new MissingBoqItemError(`Unexpected item field: ${key}.`)
  }
  const desc = item.desc
  if (typeof desc !== "string" || !desc.trim() || desc.length > 500) {
    throw new MissingBoqItemError("desc must be a non-empty description.")
  }
  const unit = item.unit
  if (typeof unit !== "string" || !unit.trim() || unit.length > 50) {
    throw new MissingBoqItemError("unit must be a non-empty string.")
  }
  const qty = requireFiniteNonNegative("qty", item.qty)
  const materialCost = requireFiniteNonNegative("materialCost", item.materialCost)
  const labourCost = requireFiniteNonNegative("labourCost", item.labourCost)
  for (const field of COMPONENT_FIELDS) {
    requireCentsPrecision(field, field === "materialCost" ? materialCost : labourCost)
  }
  return { sectionIndex: Number(value.sectionIndex), desc: desc.trim(), unit: unit.trim(), qty, materialCost, labourCost }
}

/** Server-resolved provenance reconstructed from the immutable review draft.
 *  Carries only coordinates the client is forbidden to supply. */
export interface ValidatedSourceMapping {
  sourceRowId: string
  sourceRowIds: string[]
  sourceRef?: BoqSourceRef
  sourceCosts?: BoqSourceCosts | null
}

/** Build a `user`-origin priced item with full source provenance and a manual
 *  cost allocation. Rate/total are computed server-side from the user components
 *  and must reconcile exactly; provenance comes exclusively from the mapping. */
export function addSourceBackedBoqItem(input: {
  boq: Boq
  validatedSourceMapping: ValidatedSourceMapping
  userValues: SourceBackedItemRequest
  itemId: string
}): { boq: Boq; item: BoqPricedItem } {
  const { boq, validatedSourceMapping: mapping, userValues, itemId } = input
  if (boq.status === "approved") throw new MissingBoqItemError("Approved BOQs are read-only.")
  if (!itemId.trim()) throw new MissingBoqItemError("A stable item ID is required.")
  const section = boq.sections[userValues.sectionIndex]
  if (!section) throw new MissingBoqItemError("sectionIndex does not exist.")
  if (!mapping.sourceRowIds.length || !mapping.sourceRowId.trim()) {
    throw new MissingBoqItemError("A source-backed mapping requires at least one declared source row.")
  }
  const baseItem: BoqPricedItem = {
    id: itemId,
    desc: userValues.desc,
    unit: userValues.unit,
    qty: userValues.qty,
    rate: 0,
    total: 0,
    type: "unit",
    pricingRole: "standard",
    costComponent: "combined",
    entryOrigin: "user",
    sourceRowId: mapping.sourceRowId,
    sourceRowIds: [...mapping.sourceRowIds],
    ...(mapping.sourceRef ? { sourceRef: { ...mapping.sourceRef } } : {}),
    ...(mapping.sourceCosts ? { sourceCosts: cloneSourceCosts(mapping.sourceCosts) } : {}),
    stdStatus: "unmatched",
  }
  let item: BoqPricedItem
  try {
    item = applyManualCostAllocation(baseItem, userValues.materialCost, userValues.labourCost)
  } catch (error) {
    throw new MissingBoqItemError(error instanceof Error ? error.message : "Component costs must be finite and non-negative.")
  }
  if (!costAllocationReconciles(item)) {
    throw new MissingBoqItemError("Material and labour components do not reconcile with the row rate and total.")
  }
  const sections = boq.sections.map((candidate, index) =>
    index === userValues.sectionIndex ? { ...candidate, items: [...candidate.items, item] } : candidate,
  )
  const boqWithTotals = { ...boq, sections, ...calculateBoqTotals(sections) }
  return {
    boq: { ...boqWithTotals, stdStatus: boq.stdStatus === "complete" ? "partial" : boq.stdStatus },
    item,
  }
}

function cloneSourceCosts(costs: BoqSourceCosts): BoqSourceCosts {
  return {
    material: cloneSourceCost(costs.material),
    labour: cloneSourceCost(costs.labour),
  }
}

function cloneSourceCost(cost: BoqSourceCost): BoqSourceCost {
  return { ...cost }
}
