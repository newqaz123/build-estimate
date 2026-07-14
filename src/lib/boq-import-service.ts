import type { Boq } from './boq-schema'
import { buildDraftBoq, type DoclingResultV2 } from './boq-ingestion'
import { boqSourcePath, isSourceObjectNotFound } from './boq-source-storage'
import { DoclingClientError } from './docling-client'
import type { WorkspaceSettings } from './settings-schema'

const DEFAULT_DOCLING_ENDPOINT = 'http://localhost:5001'

export interface ImportServiceDependencies {
  getWorkspaceSettings(): Promise<Pick<WorkspaceSettings, 'docling'> | null>
  saveSourcePdf(path: string, bytes: Uint8Array): Promise<void>
  sourcePdfExists(path: string): Promise<boolean>
  parsePdfWithDocling(file: File, endpoint: string, signal?: AbortSignal): Promise<DoclingResultV2>
  createDocumentWithId(collection: string, id: string, data: Record<string, unknown>): Promise<void>
  getBoq(id: string): Promise<Boq | null>
  deleteSourcePdf(path: string): Promise<void>
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
): Promise<Omit<Boq, 'createdAt' | 'updatedAt'> | Boq> {
  throwIfCancelled(signal)
  const sourcePath = boqSourcePath(id)
  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    await dependencies.saveSourcePdf(sourcePath, bytes)
  } catch (saveError) {
    if (!await dependencies.sourcePdfExists(sourcePath)) throw saveError
  }

  let draft: Omit<Boq, 'createdAt' | 'updatedAt'>
  try {
    throwIfCancelled(signal)
    const settings = await dependencies.getWorkspaceSettings()
    const endpoint = settings?.docling?.endpoint?.trim() || DEFAULT_DOCLING_ENDPOINT
    const parsed = await dependencies.parsePdfWithDocling(file, endpoint, signal)
    throwIfCancelled(signal)
    draft = buildDraftBoq(id, sourcePath, parsed)
  } catch (error) {
    await rollbackSource(sourcePath, dependencies)
    throw error
  }

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
