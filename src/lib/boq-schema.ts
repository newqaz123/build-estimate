import type {
  ExtractedPricingSnapshot,
  PricingNormalization,
  ReviewerPricingSnapshot,
} from './actionable-review-types'
import type { BoqSourceQuoteSummary } from './boq-source-quote-summary'

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
  extractedPricing?: ExtractedPricingSnapshot
  reviewerPricing?: ReviewerPricingSnapshot
  pricingNormalization?: PricingNormalization
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
  sourceQuoteSummary?: BoqSourceQuoteSummary
  activeExtractionRunId?: string
  extractionWarnings?: BoqExtractionWarning[]
  metadataConfidence?: BoqMetadataConfidence
  /** Set by the one-step Approve; removed by Reopen to edit. */
  approvedAt?: string
  /** sha256 of the uploaded PDF bytes ("sha256:<hex>"); used to spot repeat uploads. */
  sourceDigest?: string
  /** Set on Approve when the user said this is the same quote as another approved one; left out of price history. */
  duplicateOfBoqId?: string
  /** Approved quotes the user confirmed are different quotes despite looking the same. */
  confirmedDistinctFrom?: string[]
  /** Last time an approved quote was reopened for editing. */
  reopenedAt?: string
  createdAt: string
  updatedAt: string
}
