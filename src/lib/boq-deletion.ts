import type { Boq } from './boq-schema'
import type { BoqItemRequestIdentity } from './boq-item-identity'
import { resolveBoqItemIdentity } from './boq-item-identity'
import type { StandardEntry, StandardSourceItem } from './standard-schema'
import { calculateBoqTotals, isPricedBoqItem } from './boq-pricing'

function sourceMatches(source: StandardSourceItem, boqId: string, sectionIndex: number, identity: BoqItemRequestIdentity): boolean {
  if (source.boqId !== boqId || source.sectionIndex !== sectionIndex) return false
  return identity.itemId ? source.itemId === identity.itemId : source.itemCode === identity.itemCode
}

function withSources(standard: StandardEntry, sourceItems: StandardSourceItem[]): StandardEntry {
  return {
    ...standard,
    sourceItems,
    sourceBoqCount: new Set(sourceItems.map((source) => source.boqId)).size,
  }
}

function stdStatus(sections: Boq['sections']): Boq['stdStatus'] {
  const items = sections.flatMap((section) => section.items).filter(isPricedBoqItem)
  if (items.every((item) => item.stdStatus !== 'matched')) return 'none'
  return items.every((item) => item.stdStatus === 'matched') ? 'complete' : 'partial'
}

export function pruneBoqFromStandards(boqId: string, standards: StandardEntry[]): StandardEntry[] {
  return standards.map((standard) => withSources(
    standard,
    (standard.sourceItems ?? []).filter((source) => source.boqId !== boqId),
  ))
}

export function deleteBoqItemAndPruneStandards(
  boq: Boq,
  standards: StandardEntry[],
  sectionIndex: number,
  identity: BoqItemRequestIdentity,
): { boq: Boq; standards: StandardEntry[] } {
  if (boq.totalItems <= 1 || boq.sections.flatMap((section) => section.items).length <= 1) {
    throw new Error('Delete the entire BOQ instead of removing its final item.')
  }
  const section = boq.sections[sectionIndex]
  if (!section) throw new Error('Section not found.')
  const resolution = resolveBoqItemIdentity(section.items, identity)
  if (resolution.status === 'ambiguous') throw new Error('BOQ item identity is ambiguous.')
  if (resolution.status !== 'found') throw new Error('BOQ item not found.')

  const sections = boq.sections
    .map((candidate, index) => index === sectionIndex
      ? { ...candidate, items: candidate.items.filter((_, itemIndex) => itemIndex !== resolution.index) }
      : candidate)
    .filter((candidate) => candidate.items.length > 0)
  const { totalItems, grandTotal } = calculateBoqTotals(sections)

  return {
    boq: { ...boq, sections, totalItems, grandTotal, stdStatus: stdStatus(sections) },
    standards: standards.map((standard) => withSources(
      standard,
      (standard.sourceItems ?? []).filter((source) => !sourceMatches(source, boq.id, sectionIndex, identity)),
    )),
  }
}
