export interface BoqSection {
  header: string
  items: BoqItem[]
}

export interface BoqItem {
  code: string
  desc: string
  unit: string
  qty: number
  rate: number
  total: number
  type: 'unit' | 'lump_sum' | 'job'
  stdStatus: 'matched' | 'unmatched' | 'pending'
  stdMatch?: string
  stdId?: string
  stdConfidence?: 'exact' | 'fuzzy' | 'llm' | 'manual'
  sourceDesc?: string
  sourceUnit?: string
}

export interface Boq {
  id: string
  project: string
  vendor: string
  vendorId?: string
  workType: 'Structural' | 'MEP' | 'Finishing'
  date: string
  totalItems: number
  grandTotal: number
  status: 'draft' | 'parsed' | 'active' | 'review' | 'approved' | 'rejected'
  stdStatus: 'complete' | 'partial' | 'none'
  sections: BoqSection[]
  createdAt: string
  updatedAt: string
}
