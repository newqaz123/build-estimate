import {
  applyManualCostAllocation,
  deriveSourceCostAllocation,
} from './boq-cost-allocation'
import { getBoqItemIdentityKey } from './boq-item-identity'
import { isPricedBoqItem } from './boq-pricing'
import type { BoqInformationalItem, BoqItem, BoqPricedItem, BoqSection } from './boq-schema'

interface UnifiedBoqRowBase {
  key: string
  sectionIndex: number
  itemIndex: number
}

export interface UnifiedBoqPricedRow extends UnifiedBoqRowBase {
  item: BoqPricedItem
}

export interface UnifiedBoqInformationalRow extends UnifiedBoqRowBase {
  item: BoqInformationalItem
}

export type UnifiedBoqRow = UnifiedBoqPricedRow | UnifiedBoqInformationalRow

export function isPricedUnifiedBoqRow(row: UnifiedBoqRow): row is UnifiedBoqPricedRow {
  return isPricedBoqItem(row.item)
}

interface UnifiedBoqRowDraft extends UnifiedBoqRowBase {
  item: BoqItem
}

export interface UnifiedBoqSection {
  header: string
  sectionIndex: number
  rows: UnifiedBoqRow[]
}

export interface ComponentCostView {
  basis: 'rate' | 'total' | null
  material: number | null
  labour: number | null
  allocationRequired: boolean
}

export function buildUnifiedBoqSections(sections: BoqSection[]): UnifiedBoqSection[] {
  return sections.map((section, sectionIndex) => ({
    header: section.header,
    sectionIndex,
    rows: section.items.map((item, itemIndex) => {
      const row: UnifiedBoqRowDraft = {
        key: `section:${sectionIndex}:${getBoqItemIdentityKey(item) ?? `item:${itemIndex}`}`,
        sectionIndex,
        itemIndex,
        item,
      }
      return row as UnifiedBoqRow
    }),
  }))
}

export function componentCostView(item: BoqPricedItem): ComponentCostView {
  const allocation = deriveSourceCostAllocation(item)
  if (!allocation) {
    return { basis: null, material: null, labour: null, allocationRequired: true }
  }

  return {
    basis: allocation.basis,
    material: allocation.material,
    labour: allocation.labour,
    allocationRequired: false,
  }
}

export function initializeComponentAllocation(item: BoqPricedItem, material: number, labour: number): BoqPricedItem {
  return applyManualCostAllocation(item, material, labour)
}

export function applyComponentCostEdit(
  item: BoqPricedItem,
  component: 'material' | 'labour',
  value: number,
): BoqPricedItem {
  const allocation = deriveSourceCostAllocation(item)
  if (!allocation) {
    throw new Error('Component allocation is required before editing component costs.')
  }

  return applyManualCostAllocation(
    item,
    component === 'material' ? value : allocation.material,
    component === 'labour' ? value : allocation.labour,
  )
}
