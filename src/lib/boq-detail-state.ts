import {
  resolveBoqItemIdentityKey,
  type BoqItemLocation,
} from "./boq-item-identity"
import { applyManualCostAllocation, deriveSourceCostAllocation } from "./boq-cost-allocation"
import { isPricedBoqItem } from "./boq-pricing"
import type { Boq, BoqItem, BoqPricedItem } from "./boq-schema"

export type BoqDetailEdits = Record<string, Record<string, string | number | undefined>>

export type BoqUpdatedAtComparison =
  | 'incoming-newer'
  | 'incoming-older'
  | 'equal'
  | 'invalid'

export interface ResolvedBoqDetailEdit extends BoqItemLocation {
  edit: Record<string, string | number | undefined>
}

export interface BoqDraftResolutionIssue {
  identityKey: string
  status: 'not-found' | 'ambiguous'
}

export interface BoqMutationReconciliation {
  boq: Boq
  edits: BoqDetailEdits
  issues: BoqDraftResolutionIssue[]
}

function matchedStandardizationChanged(
  previous: Boq["sections"][number]["items"][number],
  incoming: Boq["sections"][number]["items"][number],
): boolean {
  if (incoming.stdStatus !== "matched" || !incoming.stdId?.trim()) return false
  if (!isPricedBoqItem(previous) || !isPricedBoqItem(incoming)) return false
  return previous.stdStatus !== incoming.stdStatus
    || previous.stdId !== incoming.stdId
    || previous.stdMatch !== incoming.stdMatch
    || previous.stdConfidence !== incoming.stdConfidence
    || previous.desc !== incoming.desc
    || previous.unit !== incoming.unit
}

export function compareBoqUpdatedAt(
  current: Pick<Boq, "updatedAt">,
  incoming: Pick<Boq, "updatedAt">,
): BoqUpdatedAtComparison {
  const currentMs = Date.parse(current.updatedAt)
  const incomingMs = Date.parse(incoming.updatedAt)
  if (!Number.isFinite(currentMs) || !Number.isFinite(incomingMs)) return "invalid"
  if (incomingMs > currentMs) return "incoming-newer"
  if (incomingMs < currentMs) return "incoming-older"
  return "equal"
}

export function mergeBoqItemEdits(
  item: BoqItem,
  edited: BoqDetailEdits[string] = {},
): BoqItem {
  const { materialCost, labourCost, ...directEdits } = edited
  if (!isPricedBoqItem(item)) {
    return typeof directEdits.desc === "string" ? { ...item, desc: directEdits.desc } : item
  }
  let merged = { ...item, ...directEdits } as BoqPricedItem
  if (materialCost !== undefined || labourCost !== undefined) {
    const allocation = deriveSourceCostAllocation(item)
    merged = applyManualCostAllocation(
      merged,
      Number(materialCost ?? allocation?.material ?? 0),
      Number(labourCost ?? allocation?.labour ?? 0),
    )
  }
  if (directEdits.qty !== undefined || directEdits.rate !== undefined) merged.total = merged.qty * merged.rate
  return merged
}

export function resolveBoqDetailEdits(
  boq: Boq,
  edits: BoqDetailEdits,
): {
  resolved: ResolvedBoqDetailEdit[]
  issues: BoqDraftResolutionIssue[]
} {
  const resolved: ResolvedBoqDetailEdit[] = []
  const issues: BoqDraftResolutionIssue[] = []
  for (const identityKey of Object.keys(edits)) {
    const resolution = resolveBoqItemIdentityKey(boq.sections, identityKey)
    if (resolution.status === "found") {
      resolved.push({
        ...resolution.location,
        edit: edits[identityKey]!,
      })
    } else {
      issues.push({ identityKey, status: resolution.status })
    }
  }
  return { resolved, issues }
}

export function applyBoqDetailEdits(
  boq: Boq,
  edits: BoqDetailEdits,
): {
  boq: Boq
  issues: BoqDraftResolutionIssue[]
} {
  const { resolved, issues } = resolveBoqDetailEdits(boq, edits)
  if (resolved.length === 0) return { boq, issues }

  const clonedSections = new Map<number, BoqItem[]>()
  for (const entry of resolved) {
    let sectionItems = clonedSections.get(entry.sectionIndex)
    if (!sectionItems) {
      sectionItems = [...boq.sections[entry.sectionIndex]!.items]
      clonedSections.set(entry.sectionIndex, sectionItems)
    }
    sectionItems[entry.itemIndex] = mergeBoqItemEdits(entry.item, entry.edit)
  }

  const sections = boq.sections.map((section, sectionIndex) => {
    const replacement = clonedSections.get(sectionIndex)
    return replacement ? { ...section, items: replacement } : section
  })

  return { boq: { ...boq, sections }, issues }
}

export function takeBoqDetailDraft(
  edits: BoqDetailEdits,
  identityKey: string,
): {
  edits: BoqDetailEdits
  draft?: BoqDetailEdits[string]
} {
  if (!(identityKey in edits)) return { edits }
  const draft = edits[identityKey]
  const remaining: BoqDetailEdits = {}
  for (const key of Object.keys(edits)) {
    if (key !== identityKey) remaining[key] = edits[key]
  }
  return { edits: remaining, draft }
}

export function restoreBoqDetailDraft(
  edits: BoqDetailEdits,
  identityKey: string,
  draft: BoqDetailEdits[string] | undefined,
): BoqDetailEdits {
  if (draft === undefined) return edits
  return { ...edits, [identityKey]: draft }
}

/**
 * Deterministic shallow equality for two primitive-field edit records: equal
 * when they share the same keys and every value is `Object.is`-equal. Order-
 * independent (no JSON string comparison), so two records with the same fields in
 * a different declaration order compare equal.
 */
function shallowEditRecordEqual(
  a: BoqDetailEdits[string],
  b: BoqDetailEdits[string],
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

/**
 * Returns a copy of `edits` with a snapshot key removed only when the current
 * draft value still equals the captured snapshot value. Drafts created or
 * restored after capture (absent from the snapshot) and drafts for the same key
 * that were changed during the in-flight Save (current value no longer equals
 * the captured value) are preserved. Used at the Save success boundary so
 * clearing the saved drafts never discards unrelated or newer work.
 */
export function clearBoqDetailDraftSnapshot(
  edits: BoqDetailEdits,
  snapshot: BoqDetailEdits,
): BoqDetailEdits {
  if (Object.keys(snapshot).length === 0) return edits
  const next: BoqDetailEdits = {}
  for (const key of Object.keys(edits)) {
    const captured = snapshot[key]
    // Keep the draft when it was created/restored after capture (absent from
    // the snapshot) or when the same key changed during the in-flight Save.
    if (captured === undefined || !shallowEditRecordEqual(edits[key]!, captured)) {
      next[key] = edits[key]
    }
  }
  return next
}

export function reconcileBoqMutation(
  previous: Boq,
  incoming: Boq,
  edits: BoqDetailEdits,
): BoqMutationReconciliation {
  const sourceAvailable = typeof incoming.sourceAvailable === "boolean"
    ? incoming.sourceAvailable
    : previous.sourceAvailable
  const reconciledBoq = sourceAvailable === undefined
    ? incoming
    : { ...incoming, sourceAvailable }
  let reconciledEdits = edits
  const issues: BoqDraftResolutionIssue[] = []

  for (const identityKey of Object.keys(edits)) {
    const previousResolution = resolveBoqItemIdentityKey(
      previous.sections,
      identityKey,
    )
    const incomingResolution = resolveBoqItemIdentityKey(
      incoming.sections,
      identityKey,
    )

    if (
      previousResolution.status !== "found"
      || incomingResolution.status !== "found"
    ) {
      issues.push({
        identityKey,
        status: previousResolution.status === "ambiguous"
          || incomingResolution.status === "ambiguous"
          ? "ambiguous"
          : "not-found",
      })
      continue
    }

    if (
      matchedStandardizationChanged(
        previousResolution.location.item,
        incomingResolution.location.item,
      )
    ) {
      const rowEdits = edits[identityKey]
      if (!rowEdits || (rowEdits.desc === undefined && rowEdits.unit === undefined)) continue
      if (reconciledEdits === edits) reconciledEdits = { ...edits }
      const remaining = { ...rowEdits }
      delete remaining.desc
      delete remaining.unit
      if (Object.keys(remaining).length > 0) reconciledEdits[identityKey] = remaining
      else delete reconciledEdits[identityKey]
    }
  }

  return { boq: reconciledBoq, edits: reconciledEdits, issues }
}
