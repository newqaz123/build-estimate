export interface EstimateCatalogSnapshot {
  description: string
  unit: string
  qty?: number
  rate?: number
}

export interface EstimateItem {
  code: string
  desc: string
  unit: string
  qty: number
  rate: number
  total: number
  source: 'imported' | 'manual' | 'adjustment'
  boqId?: string
  boqItemCode?: string
  stdId?: string
  stdSnapshot?: EstimateCatalogSnapshot
}

export function normalizeEstimateItemSnapshot(
  item: Pick<EstimateItem, 'stdId' | 'desc' | 'unit' | 'stdSnapshot'>,
): EstimateCatalogSnapshot | undefined {
  const stdId = typeof item.stdId === 'string' ? item.stdId.trim() : ''
  if (!stdId) return undefined

  const saved = item.stdSnapshot
  const description = typeof saved?.description === 'string' && saved.description.trim()
    ? saved.description.trim()
    : typeof item.desc === 'string'
      ? item.desc.trim()
      : ''
  const unit = typeof saved?.unit === 'string' && saved.unit.trim()
    ? saved.unit.trim()
    : typeof item.unit === 'string'
      ? item.unit.trim()
      : ''

  if (!description || !unit) return undefined

  return {
    description,
    unit,
    ...(typeof saved?.qty === 'number' && Number.isFinite(saved.qty) && saved.qty >= 0 ? { qty: saved.qty } : {}),
    ...(typeof saved?.rate === 'number' && Number.isFinite(saved.rate) && saved.rate >= 0 ? { rate: saved.rate } : {}),
  }
}

export interface Estimate {
  id: string
  name: string
  project?: string
  date: string
  notes?: string
  items: EstimateItem[]
  totalAmount: number
  status: 'draft' | 'final'
  createdAt: string
  updatedAt: string
}
