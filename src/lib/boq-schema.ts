export interface BoqSection {
  header: string
  items: BoqItem[]
}

export type WorkType = 'Structural' | 'MEP' | 'Finishing' | 'Unclassified'

export interface BoqSourceRef {
  page: number
  table: number
  row: number
}

export interface BoqSourceCost {
  present: boolean
  qty: number
  unit: string
  rate: number
  total: number
}

export interface BoqSourceCosts {
  material: BoqSourceCost
  labour: BoqSourceCost
}

export type BoqCostAllocation =
  | {
      basis: 'rate'
      material: number
      labour: number
      origin: 'source' | 'manual'
    }
  | {
      basis: 'total'
      material: number
      labour: number
      origin: 'source' | 'manual'
    }

export interface BoqExtractionWarning {
  code: string
  message: string
  sourceRef?: BoqSourceRef
}

export interface BoqMetadataConfidence {
  vendor: number
  project: number
  date: number
  workType: number
}

export type BoqEntryOrigin = 'docling' | 'ai_accepted' | 'user'

export interface BoqItemCommon {
  id?: string
  code?: string
  desc: string
  sourceRef?: BoqSourceRef
  sourceRowId?: string
  sourceRowIds?: string[]
  parentBundleId?: string
  entryOrigin?: BoqEntryOrigin
  optional?: boolean
  excludedFromTotal?: boolean
  exclusionReason?: string
  extractionWarnings?: BoqExtractionWarning[]
  stdStatus: 'matched' | 'unmatched' | 'pending' | 'excluded'
  stdExclusionReason?: string
  stdMatch?: string
  stdId?: string
  stdConfidence?: 'exact' | 'fuzzy' | 'llm' | 'manual'
  sourceDesc?: string
  sourceUnit?: string
}

export interface BoqPricedItem extends BoqItemCommon {
  pricingRole?: 'standard' | 'bundle_parent'
  unit: string
  qty: number
  rate: number
  total: number
  type: 'unit' | 'lump_sum' | 'job'
  costComponent?: 'material' | 'labour' | 'combined' | 'lump_sum'
  sourceCosts?: BoqSourceCosts
  costAllocation?: BoqCostAllocation
}

export interface BoqInformationalItem extends BoqItemCommon {
  pricingRole: 'bundle_child'
  parentBundleId: string
}

export type BoqItem = BoqPricedItem | BoqInformationalItem

export interface Boq {
  id: string
  project: string
  vendor: string
  vendorId?: string
  workType: WorkType
  date: string
  totalItems: number
  grandTotal: number
  status: 'draft' | 'parsed' | 'active' | 'review' | 'approved' | 'rejected'
  stdStatus: 'complete' | 'partial' | 'none'
  sections: BoqSection[]
  sourceFileName?: string
  sourceStoragePath?: string
  sourceAvailable?: boolean
  sourcePageCount?: number
  sourceTotal?: number
  extractionWarnings?: BoqExtractionWarning[]
  metadataConfidence?: BoqMetadataConfidence
  createdAt: string
  updatedAt: string
}
