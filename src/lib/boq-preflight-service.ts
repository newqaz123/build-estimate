import crypto from 'node:crypto'

import type { PreflightUpload } from './boq-preflight-schema'
import { parseConfirmedPageSelection } from './boq-preflight-schema'
import type { PreflightStore } from './boq-preflight-storage'
import type { PreflightPageInput } from './boq-preflight-analysis'
import { analyzePreflightPages } from './boq-preflight-analysis'

export interface PreflightService {
  createPreflight(file: File, actorId: string): Promise<PreflightUpload>
  consumePreflight(id: string, actorId: string, selection: { pages: number[] }): Promise<{
    file: File
    pages: number[]
    preflightId: string
  }>
  cancelPreflight(id: string, actorId: string): Promise<void>
}

export interface PreflightAnalysisAdapter {
  analyzePdf(file: File, signal?: AbortSignal): Promise<PreflightPageInput[]>
}

export interface PreflightStorageAdapter {
  saveSource(file: File, ownerId: string, id: string): Promise<string>
  loadSource(ownerId: string, id: string): Promise<File>
}

export interface CreatePreflightServiceOptions {
  store: PreflightStore
  storageAdapter: PreflightStorageAdapter
  analysisAdapter: PreflightAnalysisAdapter
  requireSinglePdf: (formData: File) => File
  createId: () => string
  now: () => Date
}

/**
 * Creates a preflight service that orchestrates PDF validation, storage, analysis, and consumption.
 *
 * Key responsibilities:
 * - createPreflight: validates via requireSinglePdf, stores source, runs analysis, persists ready record
 * - consumePreflight: validates ownership + status, returns safe page metadata (NO Boq/ExtractionRun creation)
 * - cancelPreflight: marks record as cancelled
 */
export function createPreflightService(
  options: CreatePreflightServiceOptions,
): PreflightService {
  const {
    store,
    storageAdapter,
    analysisAdapter,
    requireSinglePdf,
    createId,
    now,
  } = options

  return {
    async createPreflight(file: File, actorId: string): Promise<PreflightUpload> {
      // Step 1: Validate file
      const validatedFile = requireSinglePdf(file)

      // Step 2: Create preflight record
      const id = createId()
      const timestamp = now()

      const sourceDigest = crypto
        .createHash('sha256')
        .update(Buffer.from(await validatedFile.arrayBuffer()))
        .digest('hex')
        .slice(0, 16)

      await store.create({
        id,
        fileName: validatedFile.name,
        pageCount: 0,
        status: 'uploaded',
        pages: [],
        confirmedPages: null,
        ownerId: actorId,
        sourceDigest: `sha256:${sourceDigest}`,
        sourceName: validatedFile.name,
        sourceType: validatedFile.type,
        sourceSize: validatedFile.size,
        expiresAt: new Date(timestamp.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      })

      // Step 3: Store source PDF
      try {
        await storageAdapter.saveSource(validatedFile, actorId, id)
      } catch (error) {
        // If storage fails, mark as failed and rethrow
        await store.update(id, actorId, { status: 'failed' })
        throw error
      }

      // Step 4: Run analysis
      let analysisPages: PreflightPageInput[] = []
      try {
        analysisPages = await analysisAdapter.analyzePdf(validatedFile)
      } catch (error) {
        // If analysis fails, mark as failed and rethrow
        await store.update(id, actorId, { status: 'failed' })
        throw error
      }

      // Step 5: Score pages
      const scoredPages = analyzePreflightPages(analysisPages)

      // Step 6: Update record as ready
      const updatedRecord = await store.update(id, actorId, {
        status: 'ready',
        pageCount: scoredPages.length,
        pages: scoredPages,
      })

      if (!updatedRecord) {
        throw new Error('Preflight record not found after analysis')
      }

      // Return safe metadata only (no sourceDigest, no storage path)
      return {
        id: updatedRecord.id,
        fileName: updatedRecord.fileName,
        pageCount: updatedRecord.pageCount,
        status: updatedRecord.status,
        pages: updatedRecord.pages,
        confirmedPages: updatedRecord.confirmedPages,
      }
    },

    async consumePreflight(
      id: string,
      actorId: string,
      selection: { pages: number[] },
    ): Promise<{ file: File; pages: number[]; preflightId: string }> {
      // Step 1: Get and validate ownership
      const record = await store.getOwned(id, actorId)
      if (!record) {
        throw new Error('Preflight not found')
      }

      // Step 2: Validate status
      if (record.status !== 'ready') {
        throw new Error('Preflight is not ready')
      }

      // Step 3: Validate page selection
      const validated = parseConfirmedPageSelection(selection, record.pageCount)

      // Step 4: Load source
      const file = await storageAdapter.loadSource(actorId, id)

      // Step 5: Update as consumed
      await store.update(id, actorId, {
        status: 'consumed',
        confirmedPages: validated.pages,
      })

      // CRITICAL: Do NOT create Boq or ExtractionRun - just return the file and selection
      return {
        file,
        pages: validated.pages,
        preflightId: id,
      }
    },

    async cancelPreflight(id: string, actorId: string): Promise<void> {
      // Step 1: Validate ownership
      const record = await store.getOwned(id, actorId)
      if (!record) {
        throw new Error('Preflight not found')
      }

      // Step 2: Mark as cancelled (this triggers artifact cleanup in the store)
      await store.update(id, actorId, { status: 'cancelled' })
    },
  }
}
