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
