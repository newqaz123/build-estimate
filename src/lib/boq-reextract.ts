import type { Boq } from './boq-schema'
import { buildDraftImport, type DoclingResult } from './boq-ingestion'
import { buildExtractionRun, digestBytes, fingerprintParserConfig, type BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'

export class ReextractError extends Error {
  constructor(public readonly code: 'boq_not_found' | 'source_unavailable' | 'v3_required' | 'run_persistence_failed' | 'read_only') {
    super(code === 'source_unavailable' ? 'The original BOQ source PDF is unavailable' : code === 'v3_required' ? 'Re-extraction requires Docling contract v3' : code === 'read_only' ? 'Approved BOQs are read-only' : 'BOQ re-extraction failed')
    this.name = 'ReextractError'
  }
}

export interface ReextractDependencies {
  getBoq(boqId: string): Promise<Boq | null>
  loadSource(path: string): Promise<Uint8Array>
  parsePdfWithDocling(file: File, endpoint: string): Promise<DoclingResult>
  createRunId(): string
  now(): Date
  getEndpoint(): Promise<string>
  /** Persists only immutable run evidence; it must never write the canonical BOQ. */
  persistRun(input: { run: BoqExtractionRun; rows: readonly BoqSourceRowV3[] }): Promise<BoqExtractionRun>
}

export async function reextractBoqSource(boqId: string, dependencies: ReextractDependencies): Promise<{
  canonicalBoq: Boq
  run: BoqExtractionRun
}> {
  const canonicalBoq = await dependencies.getBoq(boqId)
  if (!canonicalBoq) throw new ReextractError('boq_not_found')
  if (canonicalBoq.status === 'approved') throw new ReextractError('read_only')
  if (!canonicalBoq.sourceStoragePath) throw new ReextractError('source_unavailable')
  let bytes: Uint8Array
  try {
    bytes = await dependencies.loadSource(canonicalBoq.sourceStoragePath)
  } catch {
    throw new ReextractError('source_unavailable')
  }
  const name = canonicalBoq.sourceFileName?.trim() || 'source.pdf'
  const sourceBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const source = new File([sourceBytes], name, { type: 'application/pdf' })
  const endpoint = await dependencies.getEndpoint()
  const parsed = await dependencies.parsePdfWithDocling(source, endpoint)
  if (parsed.contractVersion !== 3) throw new ReextractError('v3_required')
  const draft = buildDraftImport(boqId, canonicalBoq.sourceStoragePath, parsed, dependencies.createRunId())
  if (!draft.run) throw new ReextractError('v3_required')
  const run = buildExtractionRun({
    seed: draft.run,
    sourceDigest: digestBytes(bytes),
    parserConfigFingerprint: fingerprintParserConfig({ endpoint, contractVersion: 3 }),
    now: dependencies.now(),
  })
  let persisted: BoqExtractionRun
  try {
    persisted = await dependencies.persistRun({ run, rows: draft.run.sourceRows })
  } catch {
    throw new ReextractError('run_persistence_failed')
  }
  // Only the active evidence pointer changes. Saved sections, metadata, catalog
  // links, and user edits remain byte-for-byte copies of the canonical snapshot.
  return { canonicalBoq: { ...canonicalBoq, activeExtractionRunId: persisted.id }, run: persisted }
}
