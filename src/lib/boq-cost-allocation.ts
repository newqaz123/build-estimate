import type { BoqCostAllocation, BoqItem, BoqPricedItem } from './boq-schema'
import { isPricedBoqItem } from './boq-pricing'

const TOLERANCE = 0.01

function requireComponent(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`)
  if (value < 0) throw new Error(`${name} must be non-negative.`)
  return value
}

export function deriveSourceCostAllocation(item: BoqItem): BoqCostAllocation | undefined {
  if (!isPricedBoqItem(item)) return undefined
  if (item.costAllocation) return item.costAllocation

  if (item.type !== 'lump_sum' && item.sourceCosts?.material.present && item.sourceCosts.labour.present) {
    return {
      basis: 'rate',
      material: item.sourceCosts.material.rate,
      labour: item.sourceCosts.labour.rate,
      origin: 'source',
    }
  }

  if (item.type !== 'lump_sum' && item.costComponent === 'material') {
    return { basis: 'rate', material: item.rate, labour: 0, origin: 'source' }
  }
  if (item.type !== 'lump_sum' && item.costComponent === 'labour') {
    return { basis: 'rate', material: 0, labour: item.rate, origin: 'source' }
  }

  return undefined
}

export function applyManualCostAllocation(item: BoqItem, material: number, labour: number): BoqPricedItem {
  if (!isPricedBoqItem(item)) throw new TypeError('Cost allocation requires a priced BOQ item.')
  const safeMaterial = requireComponent(material, 'Material component')
  const safeLabour = requireComponent(labour, 'Labour component')
  const combined = safeMaterial + safeLabour

  if (item.type === 'lump_sum') {
    return {
      ...item,
      rate: item.qty > 0 ? combined / item.qty : combined,
      total: combined,
      costAllocation: {
        basis: 'total',
        material: safeMaterial,
        labour: safeLabour,
        origin: 'manual',
      },
    }
  }

  return {
    ...item,
    rate: combined,
    total: item.qty * combined,
    costAllocation: {
      basis: 'rate',
      material: safeMaterial,
      labour: safeLabour,
      origin: 'manual',
    },
  }
}

export function costAllocationReconciles(item: BoqItem): boolean {
  if (!isPricedBoqItem(item)) return true
  const allocation = deriveSourceCostAllocation(item)
  if (!allocation) return true
  const combined = allocation.material + allocation.labour
  return allocation.basis === 'rate'
    ? Math.abs(combined - item.rate) <= TOLERANCE && Math.abs(item.qty * combined - item.total) <= TOLERANCE
    : Math.abs(combined - item.total) <= TOLERANCE
}
