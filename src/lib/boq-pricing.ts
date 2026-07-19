import type { BoqItem, BoqPricedItem, BoqSection } from './boq-schema'

export function isPricedBoqItem(item: BoqItem): item is BoqPricedItem {
  return item.pricingRole !== 'bundle_child'
}

export function contributesToBoqTotal(item: BoqItem): item is BoqPricedItem {
  return isPricedBoqItem(item) && item.excludedFromTotal !== true
}

export function calculateBoqTotals(sections: BoqSection[]): {
  totalItems: number
  grandTotal: number
} {
  let totalItems = 0
  let grandTotal = 0

  for (const section of sections) {
    for (const item of section.items) {
      if (!isPricedBoqItem(item)) continue

      totalItems += 1
      if (!contributesToBoqTotal(item)) continue

      if (!Number.isFinite(item.total)) {
        throw new RangeError('Contributing BOQ item total must be finite')
      }
      if (item.total < 0) {
        throw new RangeError('Contributing BOQ item total must be non-negative')
      }

      grandTotal += item.total
      if (!Number.isFinite(grandTotal)) {
        throw new RangeError('BOQ grand total must remain finite')
      }
    }
  }

  return { totalItems, grandTotal }
}
