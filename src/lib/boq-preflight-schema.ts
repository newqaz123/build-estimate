export type PreflightStatus =
  | 'uploaded'
  | 'analyzing'
  | 'ready'
  | 'consumed'
  | 'cancelled'
  | 'failed'
  | 'expired'

export type PreflightTextSource = 'embedded' | 'ocr' | 'unavailable'

export interface PreflightPage {
  page: number
  suggested: boolean
  confidence: number
  reasons: string[]
  textSource: PreflightTextSource
}

export interface PreflightUpload {
  id: string
  fileName: string
  pageCount: number
  status: PreflightStatus
  pages: PreflightPage[]
  confirmedPages: number[] | null
}

export interface PreflightRecord extends PreflightUpload {
  ownerId: string
  sourceDigest: string
  sourceName: string
  sourceType: string
  sourceSize: number
  expiresAt: string
  createdAt: string
  updatedAt: string
  cleanupState?: 'deleting'
  cleanupToken?: string
  cleanupLeaseExpiresAt?: string
}

function invalid(message: string): never {
  throw new Error(`Invalid confirmed page selection: ${message}`)
}

export function parseConfirmedPageSelection(value: unknown, pageCount: number): { pages: number[] } {
  if (!Number.isInteger(pageCount) || pageCount < 1) invalid('pageCount must be a positive integer')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('value must be an object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => key !== 'pages')) invalid('unknown keys are not allowed')
  if (!Array.isArray(record.pages)) invalid('pages must be an array')
  if (record.pages.length === 0) invalid('at least one page must be selected')

  const pages = record.pages.map((page) => {
    if (!Number.isInteger(page)) invalid('pages must contain only integer page numbers')
    if ((page as number) < 1 || (page as number) > pageCount) {
      invalid(`pages must be between 1 and ${pageCount}`)
    }
    return page as number
  })
  return { pages: [...new Set(pages)].sort((left, right) => left - right) }
}
