import { normalizeEstimateItemSnapshot, type Estimate, type EstimateItem } from './estimate-schema'

export type PreparedEstimateItems =
  | { ok: true; items: EstimateItem[]; totalAmount: number }
  | { ok: false; error: string }

const SOURCES: ReadonlyArray<EstimateItem['source']> = ['imported', 'manual', 'adjustment']

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Validates estimate lines and prices them on the server. A line total is
 *  always quantity × unit price; any total the browser sends is ignored, and
 *  fields the estimate schema does not define are dropped. */
export function prepareEstimateItems(value: unknown): PreparedEstimateItems {
  if (!Array.isArray(value)) return { ok: false, error: 'Items must be a list.' }

  const items: EstimateItem[] = []
  for (const [index, raw] of value.entries()) {
    const line = `Line ${index + 1}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `${line} is not a valid estimate line.` }
    }
    const input = raw as Record<string, unknown>
    if (typeof input.desc !== 'string') return { ok: false, error: `${line}: description must be text.` }
    if (typeof input.unit !== 'string') return { ok: false, error: `${line}: unit must be text.` }
    if (!isNonNegativeNumber(input.qty)) return { ok: false, error: `${line}: quantity must be a number of zero or more.` }
    if (!isNonNegativeNumber(input.rate)) return { ok: false, error: `${line}: unit price must be a number of zero or more.` }
    const total = input.qty * input.rate
    if (!Number.isFinite(total)) return { ok: false, error: `${line}: total is too large.` }

    const item: EstimateItem = {
      code: typeof input.code === 'string' ? input.code : '',
      desc: input.desc,
      unit: input.unit,
      qty: input.qty,
      rate: input.rate,
      total,
      source: SOURCES.includes(input.source as EstimateItem['source']) ? input.source as EstimateItem['source'] : 'manual',
    }
    const boqId = optionalText(input.boqId)
    if (boqId) item.boqId = boqId
    const boqItemCode = optionalText(input.boqItemCode)
    if (boqItemCode) item.boqItemCode = boqItemCode
    const stdId = optionalText(input.stdId)
    if (stdId) {
      item.stdId = stdId
      const stdSnapshot = normalizeEstimateItemSnapshot({
        stdId,
        desc: input.desc,
        unit: input.unit,
        stdSnapshot: input.stdSnapshot as EstimateItem['stdSnapshot'],
      })
      if (stdSnapshot) item.stdSnapshot = stdSnapshot
    }
    items.push(item)
  }

  const totalAmount = items.reduce((sum, item) => sum + item.total, 0)
  if (!Number.isFinite(totalAmount)) return { ok: false, error: 'Estimate total is too large.' }
  return { ok: true, items, totalAmount }
}

export function parseEstimateStatus(value: unknown): Estimate['status'] | null {
  return value === 'draft' || value === 'final' ? value : null
}
