import type { BoqItem, BoqPricedItem, BoqSection } from './boq-schema'

export function isPricedBoqItem(item: BoqItem): item is BoqPricedItem {
  return item.pricingRole !== 'bundle_child'
}

export function contributesToBoqTotal(item: BoqItem): item is BoqPricedItem {
  return isPricedBoqItem(item) && item.excludedFromTotal !== true
}

export function parseNonNegativeBoqEditValue(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function diagnosticContext(
  sectionIndex: number,
  item: BoqPricedItem,
  itemIndex: number,
): string {
  const section = `section index ${sectionIndex + 1}`
  if (item.id !== undefined) return `${section}, item id ${JSON.stringify(item.id)}`
  return `${section}, item index ${itemIndex + 1}`
}

export function calculateBoqTotals(sections: BoqSection[]): {
  totalItems: number
  grandTotal: number
} {
  let totalItems = 0
  let grandTotal = 0

  for (const [sectionIndex, section] of sections.entries()) {
    for (const [itemIndex, item] of section.items.entries()) {
      if (!isPricedBoqItem(item)) continue

      totalItems += 1
      const context = diagnosticContext(sectionIndex, item, itemIndex)
      if (!Number.isFinite(item.total)) {
        throw new RangeError(`Priced BOQ item total must be finite (${context})`)
      }
      if (item.total < 0) {
        throw new RangeError(`Priced BOQ item total must be non-negative (${context})`)
      }
      if (!contributesToBoqTotal(item)) continue

      grandTotal += item.total
      if (!Number.isFinite(grandTotal)) {
        throw new RangeError(`BOQ grand total must remain finite (${context})`)
      }
    }
  }

  return { totalItems, grandTotal }
}
