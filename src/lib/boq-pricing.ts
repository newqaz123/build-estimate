import type { BoqItem, BoqPricedItem, BoqSection } from './boq-schema'

export function isPricedBoqItem(item: BoqItem): item is BoqPricedItem {
  return item.pricingRole !== 'bundle_child'
}

export function contributesToBoqTotal(item: BoqItem): item is BoqPricedItem {
  return isPricedBoqItem(item) && item.excludedFromTotal !== true
}

function diagnosticContext(
  sectionHeader: string,
  item: BoqPricedItem,
  itemIndex: number,
): string {
  const section = `section ${JSON.stringify(sectionHeader)}`
  if (item.id !== undefined) return `${section}, item id ${JSON.stringify(item.id)}`
  if (item.code !== undefined) return `${section}, item code ${JSON.stringify(item.code)}`
  return `${section}, item index ${itemIndex + 1}`
}

export function calculateBoqTotals(sections: BoqSection[]): {
  totalItems: number
  grandTotal: number
} {
  let totalItems = 0
  let grandTotal = 0

  for (const section of sections) {
    for (const [itemIndex, item] of section.items.entries()) {
      if (!isPricedBoqItem(item)) continue

      totalItems += 1
      if (!contributesToBoqTotal(item)) continue

      const context = diagnosticContext(section.header, item, itemIndex)
      if (!Number.isFinite(item.total)) {
        throw new RangeError(`Contributing BOQ item total must be finite (${context})`)
      }
      if (item.total < 0) {
        throw new RangeError(`Contributing BOQ item total must be non-negative (${context})`)
      }

      grandTotal += item.total
      if (!Number.isFinite(grandTotal)) {
        throw new RangeError(`BOQ grand total must remain finite (${context})`)
      }
    }
  }

  return { totalItems, grandTotal }
}
