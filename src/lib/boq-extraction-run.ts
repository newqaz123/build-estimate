import { createHash } from 'node:crypto'
import type { BoqExtractionRunSeed } from './boq-ingestion'
import type { BoqSourceQuoteSummary } from './boq-source-quote-summary'
import type {
  BoqSourceRowV3,
  DoclingMetadata,
  DoclingReconciliationV3,
  DoclingSectionV3,
  DoclingWarningV3,
} from './boq-extraction-schema'

export type ExtractionRunStatus = 'staging' | 'ready'
export type ExtractionAiReviewStatus = 'not_required' | 'queued' | 'running' | 'completed' | 'partial' | 'complete' | 'failed'

export interface BoqExtractionRun {
  id: string
  boqId: string
  contractVersion: 3
  status: ExtractionRunStatus
  createdAt: string
  updatedAt: string
  readyAt?: string
  stagingExpiresAt: string | null
  sourceFile: { path: string; name: string; digest: string }
  parser: {
    name: 'docling'
    contractVersion: 3
    configFingerprint: string
    selectedPages?: number[]
    pageSelectionContract?: 1
  }
  metadataCandidates: DoclingMetadata
  metadataConfidence: Record<keyof DoclingMetadata, number>
  sourceRowCount: number
  sourceRowChecksum: string
  reconciliation: DoclingReconciliationV3
  sourceQuoteSummary?: BoqSourceQuoteSummary
  warnings: DoclingWarningV3[]
  sections: DoclingSectionV3[]
  totalItems: number
  aiReviewStatus: ExtractionAiReviewStatus
  reviewTargeting: {
    candidateRowIds: string[]
    candidateCount: number
    /** Explicit row-level ambiguity evidence; absent only on pre-reason-model persisted runs. */
    ambiguousRowIds?: string[]
    /** Explicit row-level arithmetic/section reconciliation evidence. */
    unreconciledRowIds?: string[]
    unreconciled: boolean
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

export function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export interface BoqExtractionRunIdentity {
  boqId: string
  contractVersion: 3
  sourceFile: BoqExtractionRun['sourceFile']
  parser: BoqExtractionRun['parser']
  metadataCandidates: BoqExtractionRun['metadataCandidates']
  metadataConfidence: BoqExtractionRun['metadataConfidence']
  sourceRowCount: number
  sourceRowChecksum: string
  reconciliation: BoqExtractionRun['reconciliation']
  sourceQuoteSummary?: BoqSourceQuoteSummary
  warnings: BoqExtractionRun['warnings']
  sectionsChecksum: string
  totalItems: number
  reviewTargeting: BoqExtractionRun['reviewTargeting']
}

export function extractionRunIdentity(run: BoqExtractionRun): BoqExtractionRunIdentity {
  return {
    boqId: run.boqId,
    contractVersion: run.contractVersion,
    sourceFile: structuredClone(run.sourceFile),
    parser: structuredClone(run.parser),
    metadataCandidates: structuredClone(run.metadataCandidates),
    metadataConfidence: structuredClone(run.metadataConfidence),
    sourceRowCount: run.sourceRowCount,
    sourceRowChecksum: run.sourceRowChecksum,
    reconciliation: structuredClone(run.reconciliation),
    ...(run.sourceQuoteSummary === undefined ? {} : { sourceQuoteSummary: structuredClone(run.sourceQuoteSummary) }),
    warnings: structuredClone(run.warnings),
    sectionsChecksum: fingerprintParserConfig(run.sections),
    totalItems: run.totalItems,
    reviewTargeting: structuredClone(run.reviewTargeting),
  }
}

export function extractionRunIdentityFingerprint(run: BoqExtractionRun): string {
  return digest(stableCanonicalJson(extractionRunIdentity(run)))
}

export function stableSourceRowFingerprint(row: BoqSourceRowV3): string {
  return digest(stableCanonicalJson(row))
}

export function checksumSourceRows(rows: readonly BoqSourceRowV3[]): string {
  const fingerprints = rows
    .map((row) => ({ id: row.id, fingerprint: stableSourceRowFingerprint(row) }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return digest(stableCanonicalJson(fingerprints))
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function fingerprintParserConfig(value: unknown): string {
  return digest(stableCanonicalJson(value))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function reviewTargeting(seed: BoqExtractionRunSeed): BoqExtractionRun['reviewTargeting'] {
  const reconciliationWarningCodes = new Set([
    'item_arithmetic_mismatch',
    'component_arithmetic_mismatch',
    'component_total_mismatch',
    'section_total_mismatch',
  ])
  const warningsByRowId = new Map(seed.sourceRows.map((row) => [row.id, [...row.warnings]]))
  for (const warning of seed.warnings) {
    if (!warning.sourceRef) continue
    const row = seed.sourceRows.find((candidate) => candidate.page === warning.sourceRef?.page
      && candidate.table === warning.sourceRef?.table && candidate.row === warning.sourceRef?.row)
    if (row) warningsByRowId.get(row.id)?.push(warning)
  }
  const rowWarnings = (row: BoqSourceRowV3) => warningsByRowId.get(row.id) ?? []
  const candidates = seed.sourceRows.filter((row) =>
    row.confidence < 0.9
      || rowWarnings(row).length > 0
      || ['continuation', 'option', 'unknown'].includes(row.classification),
  )
  const ambiguous = candidates.filter((row) => row.confidence < 0.9
    || row.classification === 'unknown'
    || rowWarnings(row).some((warning) => /ambiguous|unsupported|incomplete|invalid_numeric|numeric_overflow/.test(warning.code)))
  const unreconciledRows = candidates.filter((row) =>
    rowWarnings(row).some((warning) => reconciliationWarningCodes.has(warning.code)),
  )
  return {
    candidateRowIds: candidates.map((row) => row.id),
    candidateCount: candidates.length,
    ambiguousRowIds: ambiguous.map((row) => row.id),
    unreconciledRowIds: unreconciledRows.map((row) => row.id),
    unreconciled: !seed.reconciliation.reconciled,
  }
}

function normalizeSelectedPages(pages: readonly number[] | undefined): number[] | undefined {
  if (pages === undefined) return undefined
  if (pages.length === 0 || pages.some((page) => !Number.isInteger(page) || page < 1)) {
    throw new TypeError('selectedPages must contain positive integer page numbers')
  }
  return [...new Set(pages)].sort((left, right) => left - right)
}

export function buildExtractionRun(input: {
  seed: BoqExtractionRunSeed
  sourceDigest: string
  parserConfigFingerprint: string
  selectedPages?: readonly number[]
  now: Date
  stagingTtlMs?: number
}): BoqExtractionRun {
  const createdAt = input.now.toISOString()
  const selectedPages = normalizeSelectedPages(input.selectedPages)
  const targeting = reviewTargeting(input.seed)
  const run: BoqExtractionRun = {
    id: input.seed.id,
    boqId: input.seed.boqId,
    contractVersion: 3,
    status: 'staging',
    createdAt,
    updatedAt: createdAt,
    stagingExpiresAt: new Date(input.now.getTime() + (input.stagingTtlMs ?? 86_400_000)).toISOString(),
    sourceFile: {
      path: input.seed.sourceStoragePath,
      name: input.seed.sourceFileName,
      digest: input.sourceDigest,
    },
    parser: {
      name: 'docling',
      contractVersion: 3,
      configFingerprint: input.parserConfigFingerprint,
      ...(selectedPages ? { selectedPages, pageSelectionContract: 1 as const } : {}),
    },
    metadataCandidates: structuredClone(input.seed.metadata),
    metadataConfidence: {
      vendor: input.seed.metadata.vendor.confidence,
      project: input.seed.metadata.project.confidence,
      date: input.seed.metadata.date.confidence,
      workType: input.seed.metadata.workType.confidence,
    },
    sourceRowCount: input.seed.sourceRows.length,
    sourceRowChecksum: checksumSourceRows(input.seed.sourceRows),
    reconciliation: structuredClone(input.seed.reconciliation),
    ...(input.seed.sourceQuoteSummary === undefined ? {} : { sourceQuoteSummary: structuredClone(input.seed.sourceQuoteSummary) }),
    warnings: structuredClone(input.seed.warnings),
    sections: structuredClone(input.seed.sections),
    totalItems: input.seed.totalItems,
    aiReviewStatus: targeting.candidateCount > 0 || targeting.unreconciled ? 'queued' : 'not_required',
    reviewTargeting: targeting,
  }
  return deepFreeze(run)
}
