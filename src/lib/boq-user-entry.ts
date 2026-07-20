import { calculateBoqTotals } from "./boq-pricing"
import type { Boq, BoqPricedItem } from "./boq-schema"

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
