import type { Boq } from './boq-schema'
import { buildDraftImport, type DoclingResult } from './boq-ingestion'
import {
  buildExtractionRun,
  digestBytes,
  fingerprintParserConfig,
} from './boq-extraction-run'
import {
  ExtractionCleanupUncertainError,
  persistStagedRun,
  type ExtractionStore,
} from './boq-extraction-storage'
import { boqSourcePath, isSourceObjectNotFound } from './boq-source-storage'
import { DoclingClientError, type DoclingParseOptions } from './docling-client'
import type { WorkspaceSettings } from './settings-schema'

export interface ConfirmedImportSelection {
  preflightId: string
  pages: readonly number[]
}

const DEFAULT_DOCLING_ENDPOINT = 'http://localhost:5001'

export interface ImportServiceDependencies {
  getWorkspaceSettings(): Promise<Pick<WorkspaceSettings, 'docling'> | null>
  saveSourcePdf(path: string, bytes: Uint8Array): Promise<void>
  sourcePdfExists(path: string): Promise<boolean>
  parsePdfWithDocling(file: File, endpoint: string, signal?: AbortSignal, options?: DoclingParseOptions): Promise<DoclingResult>
  createDocumentWithId(collection: string, id: string, data: Record<string, unknown>): Promise<void>
  getBoq(id: string): Promise<Boq | null>
  deleteSourcePdf(path: string): Promise<void>
  createRunId(): string
  now(): Date
  extractionStore: ExtractionStore
}

function normalizeSelection(selection?: ConfirmedImportSelection): ConfirmedImportSelection | undefined {
  if (!selection) return undefined
  if (selection.preflightId.trim() === '') throw new TypeError('preflightId must be a non-empty string')
  if (selection.pages.length === 0 || selection.pages.some((page) => !Number.isInteger(page) || page < 1)) {
    throw new TypeError('pages must contain positive integer page numbers')
  }
  return {
    preflightId: selection.preflightId,
    pages: [...new Set(selection.pages)].sort((left, right) => left - right),
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DoclingClientError('cancelled', 'Request cancelled')
}

async function rollbackSource(
  path: string,
  dependencies: Pick<ImportServiceDependencies, 'deleteSourcePdf'>,
): Promise<void> {
  try {
    await dependencies.deleteSourcePdf(path)
  } catch (error) {
    if (!isSourceObjectNotFound(error)) throw error
  }
}

export async function importPdfAtomically(
  file: File,
  id: string,
  dependencies: ImportServiceDependencies,
  signal?: AbortSignal,
  selection?: ConfirmedImportSelection,
): Promise<Omit<Boq, 'createdAt' | 'updatedAt'> | Boq> {
  throwIfCancelled(signal)
  const confirmedSelection = normalizeSelection(selection)
  const selectedPages = confirmedSelection?.pages
  const sourcePath = boqSourcePath(id)
  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    await dependencies.saveSourcePdf(sourcePath, bytes)
  } catch (saveError) {
    if (!await dependencies.sourcePdfExists(sourcePath)) throw saveError
  }

  let parsed: DoclingResult
  let endpoint: string
  try {
    throwIfCancelled(signal)
    const settings = await dependencies.getWorkspaceSettings()
    endpoint = settings?.docling?.endpoint?.trim() || DEFAULT_DOCLING_ENDPOINT
    parsed = await dependencies.parsePdfWithDocling(
      file,
      endpoint,
      signal,
      selectedPages ? { pages: selectedPages } : undefined,
    )
    throwIfCancelled(signal)
  } catch (error) {
    await rollbackSource(sourcePath, dependencies)
    throw error
  }

  let draftImport: ReturnType<typeof buildDraftImport>
  try {
    draftImport = buildDraftImport(
      id,
      sourcePath,
      parsed,
      parsed.contractVersion === 3 ? dependencies.createRunId() : 'unused-v2',
    )
  } catch (error) {
    await rollbackSource(sourcePath, dependencies)
    throw error
  }

  if (parsed.contractVersion === 3) {
    try {
      const seed = draftImport.run
      if (!seed) throw new Error('Extraction run seed missing')
      const parserConfig = {
        endpoint,
        contractVersion: 3 as const,
        ...(selectedPages
          ? { selectedPages, pageSelectionContract: 1 as const }
          : {}),
      }
      const run = buildExtractionRun({
        seed,
        sourceDigest: digestBytes(bytes),
        parserConfigFingerprint: fingerprintParserConfig(parserConfig),
        ...(selectedPages ? { selectedPages } : {}),
        now: dependencies.now(),
      })
      return await persistStagedRun({ boq: draftImport.boq, run, rows: seed.sourceRows }, dependencies.extractionStore, signal)
    } catch (error) {
      if (error instanceof ExtractionCleanupUncertainError) throw error
      await rollbackSource(sourcePath, dependencies)
      if (signal?.aborted) throw new DoclingClientError('cancelled', 'Request cancelled')
      throw error
    }
  }

  const draft = draftImport.boq

  try {
    await dependencies.createDocumentWithId('boqs', id, draft as unknown as Record<string, unknown>)
    return draft
  } catch (persistenceError) {
    let existing: Boq | null
    try {
      existing = await dependencies.getBoq(id)
    } catch (reconciliationError) {
      throw reconciliationError
    }
    if (existing) return existing
    await rollbackSource(sourcePath, dependencies)
    throw persistenceError
  }
}
