import crypto from 'node:crypto'

import type { PreflightUpload } from './boq-preflight-schema'
import { parseConfirmedPageSelection } from './boq-preflight-schema'
import type { PreflightStore } from './boq-preflight-storage'
import type { PreflightPageInput } from './boq-preflight-analysis'
import { analyzePreflightPages } from './boq-preflight-analysis'

export interface PreflightImportContext {
  file: File
  pages: number[]
  preflightId: string
}

export type PreflightImportOperation = (context: PreflightImportContext) => Promise<unknown>

const IMPORT_RESERVATION_LEASE_MS = 5 * 60 * 1000

async function digestFile(file: File): Promise<string> {
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex')}`
}

async function loadVerifiedSource(
  storageAdapter: PreflightStorageAdapter,
  actorId: string,
  id: string,
  expectedDigest: string,
): Promise<File> {
  const file = await storageAdapter.loadSource(actorId, id)
  if (await digestFile(file) !== expectedDigest) {
    throw new Error('Preflight source integrity check failed')
  }
  return file
}

export class PreflightConsumptionConflictError extends Error {
  constructor() {
    super('Preflight consumption conflict')
    this.name = 'PreflightConsumptionConflictError'
  }
}

function isReservationCasFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith('Preflight status compare-and-set failed:')
    || error.message === 'Preflight reservation compare-and-set failed'
  )
}

export interface PreflightService {
  createPreflight(file: File, actorId: string): Promise<PreflightUpload>
  consumePreflight(
    id: string,
    actorId: string,
    selection: { pages: number[] },
    operation?: PreflightImportOperation,
  ): Promise<PreflightImportContext & { operationResult?: unknown }>
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
  requireSinglePdf: (file: File) => File
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
      operation?: PreflightImportOperation,
    ): Promise<PreflightImportContext & { operationResult?: unknown }> {
      // Validate ownership, lifecycle, and the page allowlist before loading any source.
      const record = await store.getOwned(id, actorId)
      if (!record) throw new Error('Preflight not found')
      if (record.status !== 'ready') throw new Error('Preflight is not ready')
      const validated = parseConfirmedPageSelection(selection, record.pageCount)

      // The API-only consume path preserves the existing immediate lifecycle contract.
      if (!operation) {
        const context: PreflightImportContext = {
          file: await loadVerifiedSource(storageAdapter, actorId, id, record.sourceDigest),
          pages: validated.pages,
          preflightId: id,
        }
        if (!store.consume) throw new Error('Preflight consumption CAS unavailable')
        const outcome = await store.consume(id, actorId, validated.pages)
        if (outcome === 'missing') throw new Error('Preflight not found')
        if (outcome === 'conflict') throw new Error('Preflight consumption conflict')
        return context
      }

      // Reserve with a transaction-backed compare-and-set before loading/processing.
      // This closes concurrent import and cancellation races; only this token can
      // complete or restore the reservation.
      const reservationToken = crypto.randomUUID()
      const reservationLeaseExpiresAt = new Date(now().getTime() + IMPORT_RESERVATION_LEASE_MS).toISOString()
      let reserved: Awaited<ReturnType<PreflightStore['update']>>
      try {
        reserved = await store.update(id, actorId, {
          status: 'analyzing',
          confirmedPages: validated.pages,
          importReservationToken: reservationToken,
          importReservationLeaseExpiresAt: reservationLeaseExpiresAt,
          preserveForRetry: true,
        }, {
          expectedStatus: 'ready',
          expectedReservationToken: null,
        })
      } catch (error) {
        if (isReservationCasFailure(error)) throw new PreflightConsumptionConflictError()
        throw error
      }
      if (!reserved) throw new Error('Preflight is no longer ready')

      try {
        const context: PreflightImportContext = {
          file: await loadVerifiedSource(storageAdapter, actorId, id, record.sourceDigest),
          pages: validated.pages,
          preflightId: id,
        }
        const operationResult = await operation(context)
        await store.update(id, actorId, {
          status: 'consumed',
          confirmedPages: validated.pages,
          importReservationToken: null,
          importReservationLeaseExpiresAt: null,
        }, {
          expectedStatus: 'analyzing',
          expectedReservationToken: reservationToken,
          expectedReservationLeaseExpiresAt: reservationLeaseExpiresAt,
        })
        return { ...context, operationResult }
      } catch (error) {
        // Keep the source and the user's validated page selection available for retry.
        await store.update(id, actorId, {
          status: 'ready',
          confirmedPages: validated.pages,
          importReservationToken: null,
          importReservationLeaseExpiresAt: null,
          preserveForRetry: true,
        }, {
          expectedStatus: 'analyzing',
          expectedReservationToken: reservationToken,
          expectedReservationLeaseExpiresAt: reservationLeaseExpiresAt,
        })
        throw error
      }
    },

    async cancelPreflight(id: string, actorId: string): Promise<void> {
      // Step 1: Validate ownership
      const record = await store.getOwned(id, actorId)
      if (!record) {
        throw new Error('Preflight not found')
      }
      if (record.status !== 'ready') throw new Error('Preflight is not ready')

      // Step 2: Mark as cancelled (this triggers artifact cleanup in the store)
      await store.update(id, actorId, { status: 'cancelled' }, {
        expectedStatus: 'ready',
        expectedReservationToken: null,
      })
    },
  }
}
