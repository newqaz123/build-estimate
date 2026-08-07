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

/** An add decision inside a multi-row decision-batch request. */
export interface SourceRowAddDecisionRequest {
  sourceRowId: string
  action: "add"
  item: SourceBackedItemRequest
}

/** An ignore decision inside a multi-row decision-batch request. The optional
 *  note is reviewer-authored audit text only. */
export interface SourceRowIgnoreDecisionRequest {
  sourceRowId: string
  action: "ignore"
  note?: string
}

/** Closed union of per-source-row human decisions. */
export type SourceRowDecisionRequest = SourceRowAddDecisionRequest | SourceRowIgnoreDecisionRequest

/** Closed single/decision-batch request union. The server resolves provenance
 *  per row from immutable evidence; the client supplies only editable values
 *  and explicit per-row Add/Do-not-add choices. */
export type SourceBackedManualAddRequest =
  | { mode: "single"; value: SourceBackedItemRequest }
  | { mode: "decision_batch"; decisions: SourceRowDecisionRequest[] }

const SOURCE_ITEM_KEYS = new Set(["desc", "unit", "qty", "materialCost", "labourCost"])
const SOURCE_REQUEST_KEYS = new Set(["sectionIndex", "item"])
const ADD_DECISION_KEYS = new Set(["sourceRowId", "action", "sectionIndex", "item"])
const IGNORE_DECISION_KEYS = new Set(["sourceRowId", "action", "note"])
const DECISION_BATCH_KEYS = new Set(["decisions"])
const MAX_BATCH_ENTRIES = 100
const MAX_NOTE_LENGTH = 500
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

/** Parse a closed single/decision-batch manual-add request. A top-level own
 *  `decisions` key selects the decision-batch shape; every other object is
 *  parsed as the existing single shape. Decision entries reuse
 *  `parseSourceBackedItemRequest` for add-action validation and trim optional
 *  ignore notes. */
export function parseSourceBackedManualAddRequest(value: unknown): SourceBackedManualAddRequest {
  if (!isRecord(value)) throw new MissingBoqItemError("Request body must be an object.")
  if (Object.prototype.hasOwnProperty.call(value, "decisions")) {
    for (const key of Object.keys(value)) {
      if (!DECISION_BATCH_KEYS.has(key)) throw new MissingBoqItemError(`Unexpected request field: ${key}.`)
    }
    const decisions = value.decisions
    if (!Array.isArray(decisions)) throw new MissingBoqItemError("decisions must be an array.")
    if (decisions.length === 0) throw new MissingBoqItemError("decisions must not be empty.")
    if (decisions.length > MAX_BATCH_ENTRIES) {
      throw new MissingBoqItemError(`decisions must not contain more than ${MAX_BATCH_ENTRIES} entries.`)
    }
    const seenRowIds = new Set<string>()
    const entries: SourceRowDecisionRequest[] = []
    for (const entry of decisions) {
      if (!isRecord(entry)) throw new MissingBoqItemError("Each decision entry must be an object.")
      const action = entry.action
      if (action !== "add" && action !== "ignore") {
        throw new MissingBoqItemError("action must be 'add' or 'ignore'.")
      }
      for (const key of Object.keys(entry)) {
        const allowed = action === "add" ? ADD_DECISION_KEYS : IGNORE_DECISION_KEYS
        if (!allowed.has(key)) throw new MissingBoqItemError(`Unexpected decision field: ${key}.`)
      }
      const sourceRowId = entry.sourceRowId
      if (typeof sourceRowId !== "string" || !sourceRowId.trim()) {
        throw new MissingBoqItemError("sourceRowId must be a non-empty string.")
      }
      if (seenRowIds.has(sourceRowId)) {
        throw new MissingBoqItemError("sourceRowId values must be unique.")
      }
      seenRowIds.add(sourceRowId)
      if (action === "add") {
        const itemValues = parseSourceBackedItemRequest({ sectionIndex: entry.sectionIndex, item: entry.item })
        entries.push({ sourceRowId, action: "add", item: itemValues })
      } else {
        const noteValue = entry.note
        if (noteValue !== undefined) {
          if (typeof noteValue !== "string") throw new MissingBoqItemError("note must be a string.")
          if (noteValue.trim().length > MAX_NOTE_LENGTH) {
            throw new MissingBoqItemError(`note must not exceed ${MAX_NOTE_LENGTH} characters.`)
          }
        }
        const trimmed = typeof noteValue === "string" ? noteValue.trim() : ""
        entries.push(trimmed ? { sourceRowId, action: "ignore", note: trimmed } : { sourceRowId, action: "ignore" })
      }
    }
    return { mode: "decision_batch", decisions: entries }
  }
  return { mode: "single", value: parseSourceBackedItemRequest(value) }
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
