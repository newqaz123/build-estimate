import type { Boq } from './boq-schema'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import type { Firestore } from 'firebase-admin/firestore'
import { randomUUID } from 'node:crypto'
import {
  checksumSourceRows,
  extractionRunIdentity,
  extractionRunIdentityFingerprint,
  fingerprintParserConfig,
  stableCanonicalJson,
  stableSourceRowFingerprint,
  type BoqExtractionRun,
} from './boq-extraction-run'

const SOURCE_ROW_BATCH_SIZE = 200
const SECTION_ITEM_CHUNK_SIZE = 100
const CLEANUP_LEASE_MS = 5 * 60 * 1000

function validatePathPart(value: string, name: string): void {
  if (value.trim() === '' || value.includes('/')) throw new TypeError(`${name} must be one Firestore path segment`)
}

export function extractionRunPath(boqId: string, runId: string): string {
  validatePathPart(boqId, 'boqId')
  validatePathPart(runId, 'runId')
  return `boqs/${boqId}/extractionRuns/${runId}`
}

export function sourceRowPath(boqId: string, runId: string, rowId: string): string {
  validatePathPart(rowId, 'sourceRowId')
  return `${extractionRunPath(boqId, runId)}/sourceRows/${rowId}`
}

export interface ExtractionStore {
  createRun(run: BoqExtractionRun): Promise<'created' | 'exists_staging' | 'exists_deleting' | 'exists_ready'>
  writeSourceRows(boqId: string, runId: string, rows: readonly BoqSourceRowV3[]): Promise<void>
  verifySourceRows(boqId: string, runId: string): Promise<{ count: number; checksum: string }>
  finalizeBoqAndRun(
    boq: Omit<Boq, 'createdAt' | 'updatedAt'>,
    run: BoqExtractionRun,
  ): Promise<'finalized' | 'already_finalized'>
  getReadyImport(boqId: string, runId: string): Promise<{ boq: Boq; run: BoqExtractionRun } | null>
  cleanupStagingIfSafe(boqId: string, runId: string): Promise<boolean>
  deleteRunTree(boqId: string, runId: string): Promise<void>
  listExpiredStagingRuns(cutoff: string, limit: number): Promise<Array<{ boqId: string; runId: string }>>
}

export class ExtractionCleanupUncertainError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Extraction staging cleanup outcome is unknown; recovery evidence was preserved', options)
    this.name = 'ExtractionCleanupUncertainError'
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Extraction persistence cancelled')
}

function isMatchingReadyImport(
  value: { boq: Boq; run: BoqExtractionRun } | null,
  expected: BoqExtractionRun,
): value is { boq: Boq; run: BoqExtractionRun } {
  return value?.boq?.id === expected.boqId
    && value.run?.id === expected.id
    && value.run.boqId === expected.boqId
    && value.run.status === 'ready'
    && extractionRunIdentityFingerprint(value.run) === extractionRunIdentityFingerprint(expected)
}

async function cleanupOrThrow(store: ExtractionStore, boqId: string, runId: string): Promise<void> {
  try {
    const safe = await store.cleanupStagingIfSafe(boqId, runId)
    if (!safe) throw new ExtractionCleanupUncertainError()
  } catch (error) {
    if (error instanceof ExtractionCleanupUncertainError) throw error
    throw new ExtractionCleanupUncertainError({ cause: error })
  }
}

export async function persistStagedRun(
  input: {
    boq: Omit<Boq, 'createdAt' | 'updatedAt'>
    run: BoqExtractionRun
    rows: readonly BoqSourceRowV3[]
  },
  store: ExtractionStore,
  signal?: AbortSignal,
): Promise<Omit<Boq, 'createdAt' | 'updatedAt'> | Boq> {
  throwIfCancelled(signal)
  let ownsStaging = false
  let creationOutcome: Awaited<ReturnType<ExtractionStore['createRun']>> | undefined
  let safeCleanupCompleted = false
  try {
    // A rejected create can have committed, or can have collided with a
    // pre-existing run. Until the store returns an explicit outcome we do not
    // own the run and must preserve its evidence rather than deleting it.
    let creation: Awaited<ReturnType<ExtractionStore['createRun']>>
    try {
      creation = await store.createRun(input.run)
    } catch (error) {
      throw new ExtractionCleanupUncertainError({ cause: error })
    }
    if (creation === 'exists_deleting') {
      let cleaned = false
      try {
        cleaned = await store.cleanupStagingIfSafe(input.run.boqId, input.run.id)
      } catch (error) {
        throw new ExtractionCleanupUncertainError({ cause: error })
      }
      if (!cleaned) throw new ExtractionCleanupUncertainError()
      try {
        creation = await store.createRun(input.run)
      } catch (error) {
        throw new ExtractionCleanupUncertainError({ cause: error })
      }
      if (creation === 'exists_deleting') throw new ExtractionCleanupUncertainError()
    }
    creationOutcome = creation
    if (!['created', 'exists_staging', 'exists_deleting', 'exists_ready'].includes(creationOutcome)) {
      throw new ExtractionCleanupUncertainError({ cause: new Error('Extraction store result was malformed') })
    }
    if (creation === 'exists_ready') {
      let existing: { boq: Boq; run: BoqExtractionRun } | null
      try {
        existing = await store.getReadyImport(input.run.boqId, input.run.id)
      } catch (error) {
        throw new ExtractionCleanupUncertainError({ cause: error })
      }
      if (isMatchingReadyImport(existing, input.run)) return existing.boq
      throw new ExtractionCleanupUncertainError()
    }
    ownsStaging = creation === 'created'
    throwIfCancelled(signal)
    for (let index = 0; index < input.rows.length; index += SOURCE_ROW_BATCH_SIZE) {
      await store.writeSourceRows(input.run.boqId, input.run.id, input.rows.slice(index, index + SOURCE_ROW_BATCH_SIZE))
      throwIfCancelled(signal)
    }
    const verified = await store.verifySourceRows(input.run.boqId, input.run.id)
    if (verified.count !== input.run.sourceRowCount || verified.checksum !== input.run.sourceRowChecksum) {
      throw new Error('Extraction source-row verification failed')
    }
    throwIfCancelled(signal)
    try {
      const outcome = await store.finalizeBoqAndRun(input.boq, input.run)
      if (outcome === 'finalized') return input.boq
      if (outcome !== 'already_finalized') throw new Error('Extraction finalize result was malformed')
      let existing: { boq: Boq; run: BoqExtractionRun } | null
      try {
        existing = await store.getReadyImport(input.run.boqId, input.run.id)
      } catch (error) {
        throw new ExtractionCleanupUncertainError({ cause: error })
      }
      if (isMatchingReadyImport(existing, input.run)) return existing.boq
      throw new ExtractionCleanupUncertainError()
    } catch (finalizeError) {
      if (finalizeError instanceof ExtractionCleanupUncertainError) throw finalizeError
      try {
        const existing = await store.getReadyImport(input.run.boqId, input.run.id)
        if (isMatchingReadyImport(existing, input.run)) return existing.boq
        if (!ownsStaging) throw new ExtractionCleanupUncertainError({ cause: finalizeError })
        const safe = await store.cleanupStagingIfSafe(input.run.boqId, input.run.id)
        if (!safe) throw new ExtractionCleanupUncertainError({ cause: finalizeError })
        safeCleanupCompleted = true
      } catch (reconciliationError) {
        if (reconciliationError instanceof ExtractionCleanupUncertainError) throw reconciliationError
        // A failed reconciliation must preserve the run tree and source.
        throw new ExtractionCleanupUncertainError({ cause: reconciliationError })
      }
      throw finalizeError
    }
  } catch (error) {
    if (creationOutcome === 'exists_staging'
      && !ownsStaging
      && !(error instanceof ExtractionCleanupUncertainError)) {
      // This run may belong to another worker. Preserve its source/evidence
      // and make the import service treat the outcome as uncertain.
      throw new ExtractionCleanupUncertainError({ cause: error })
    }
    if (ownsStaging && !safeCleanupCompleted && !(error instanceof ExtractionCleanupUncertainError)) {
      await cleanupOrThrow(store, input.run.boqId, input.run.id)
    }
    throw error
  }
}

export async function cleanupExpiredStagingRuns(
  store: ExtractionStore,
  cutoff: string,
  limit = 100,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Cleanup limit must be between 1 and 200')
  const expired = await store.listExpiredStagingRuns(cutoff, limit)
  if (!Array.isArray(expired) || expired.length > limit) throw new Error('Extraction cleanup store result was malformed')
  let deleted = 0
  for (const run of expired) {
    if (await store.cleanupStagingIfSafe(run.boqId, run.runId)) deleted += 1
  }
  return deleted
}

export interface SectionSnapshotChunk {
  order: number
  sectionIndex: number
  sectionChunkIndex: number
  sections: BoqExtractionRun['sections']
}

function sectionChunks(run: BoqExtractionRun): SectionSnapshotChunk[] {
  const chunks: SectionSnapshotChunk[] = []
  run.sections.forEach((section, sectionIndex) => {
    if (section.items.length === 0) {
      chunks.push({ order: chunks.length, sectionIndex, sectionChunkIndex: 0, sections: [{ header: section.header, items: [] }] })
      return
    }
    for (let index = 0; index < section.items.length; index += SECTION_ITEM_CHUNK_SIZE) {
      chunks.push({
        order: chunks.length,
        sectionIndex,
        sectionChunkIndex: Math.floor(index / SECTION_ITEM_CHUNK_SIZE),
        sections: [{ header: section.header, items: section.items.slice(index, index + SECTION_ITEM_CHUNK_SIZE) }],
      })
    }
  })
  return chunks
}

export function mergeSectionChunks(
  chunks: Array<SectionSnapshotChunk | { order: number; sections: BoqExtractionRun['sections'] }>,
): BoqExtractionRun['sections'] {
  if (chunks.some((chunk) => 'sectionIndex' in chunk)) {
    const sections = new Map<number, {
      header: string
      parts: Array<{ chunkIndex: number; items: BoqExtractionRun['sections'][number]['items'] }>
    }>()
    for (const chunk of chunks.slice().sort((left, right) => left.order - right.order)) {
      if (!('sectionIndex' in chunk)) throw new Error('Mixed section snapshot boundary formats')
      const incoming = chunk.sections[0]
      if (!incoming) continue
      const existing = sections.get(chunk.sectionIndex)
      if (existing) existing.parts.push({ chunkIndex: chunk.sectionChunkIndex, items: structuredClone(incoming.items) })
      else sections.set(chunk.sectionIndex, {
        header: incoming.header,
        parts: [{ chunkIndex: chunk.sectionChunkIndex, items: structuredClone(incoming.items) }],
      })
    }
    return [...sections.entries()].sort(([left], [right]) => left - right).map(([, section]) => ({
      header: section.header,
      items: section.parts
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .flatMap((part) => part.items),
    }))
  }
  const sections: BoqExtractionRun['sections'] = []
  for (const chunk of chunks.slice().sort((left, right) => left.order - right.order)) {
    for (const incoming of chunk.sections) {
      const previous = sections.at(-1)
      if (previous?.header === incoming.header) previous.items.push(...incoming.items)
      else sections.push(structuredClone(incoming))
    }
  }
  return sections
}

/**
 * Firebase-specific adapter. Run metadata stays small; the deterministic
 * sections snapshot is chunked into a nested immutable subcollection.
 */
export function createFirestoreExtractionStore(
  db: Firestore,
  now: () => Date = () => new Date(),
): ExtractionStore {
  const runRef = (boqId: string, runId: string) => db.doc(extractionRunPath(boqId, runId))
  const snapshots = (boqId: string, runId: string) => runRef(boqId, runId).collection('sectionSnapshots')

  return {
    async createRun(run) {
      const ref = runRef(run.boqId, run.id)
      return db.runTransaction(async (transaction) => {
        const existing = await transaction.get(ref)
        if (existing.exists) {
          const data = existing.data()
          if (data?.identityFingerprint !== extractionRunIdentityFingerprint(run)
            || stableCanonicalJson(data?.extractionIdentity) !== stableCanonicalJson(extractionRunIdentity(run))) {
            throw new Error('Extraction run identity conflict')
          }
          if (data?.status === 'ready') return 'exists_ready'
          if (data?.status === 'staging' && (data?.cleanupState === 'deleting' || data?.cleanupState === 'cleanup_pending')) {
            return 'exists_deleting'
          }
          if (data?.status === 'staging') return 'exists_staging'
          throw new Error('Extraction run has an unsupported state')
        }
        const chunks = sectionChunks(run)
        if (chunks.length > 400) throw new Error('Extraction section snapshot exceeds the supported chunk count')
        const metadata = Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'sections'))
        transaction.create(ref, {
          ...metadata,
          sourceRowRevision: 0,
          extractionIdentity: extractionRunIdentity(run),
          identityFingerprint: extractionRunIdentityFingerprint(run),
          deterministicSections: {
            checksum: fingerprintParserConfig(run.sections),
            reference: `${extractionRunPath(run.boqId, run.id)}/sectionSnapshots`,
            chunkCount: chunks.length,
          },
        })
        chunks.forEach((chunk, index) => transaction.create(snapshots(run.boqId, run.id).doc(String(index).padStart(6, '0')), chunk))
        return 'created'
      })
    },

    async writeSourceRows(boqId, runId, rows) {
      if (rows.length > SOURCE_ROW_BATCH_SIZE) throw new TypeError('Source-row batch exceeds 200 records')
      const refs = rows.map((row) => db.doc(sourceRowPath(boqId, runId, row.id)))
      await db.runTransaction(async (transaction) => {
        const extractionRef = runRef(boqId, runId)
        const runSnapshot = await transaction.get(extractionRef)
        const runData = runSnapshot.data()
        if (!runSnapshot.exists || runData?.status !== 'staging' || runData.cleanupState) {
          throw new Error('Extraction run is not staged')
        }
        if (runData.verifiedSourceRowCount !== undefined || runData.verifiedSourceRowChecksum !== undefined) {
          throw new Error('Extraction source rows are already verified')
        }
        const existing = refs.length > 0 ? await transaction.getAll(...refs) : []
        let changed = false
        rows.forEach((row, index) => {
          const snapshot = existing[index]
          if (snapshot?.exists) {
            if (snapshot.data()?.fingerprint !== stableSourceRowFingerprint(row)) {
              throw new Error('Extraction source-row identity conflict')
            }
            return
          }
          changed = true
          transaction.create(refs[index], { ...row, fingerprint: stableSourceRowFingerprint(row) })
        })
        if (changed) transaction.update(extractionRef, { sourceRowRevision: (runData.sourceRowRevision ?? 0) + 1 })
      })
    },

    async verifySourceRows(boqId, runId) {
      const extractionRef = runRef(boqId, runId)
      const initialRun = await extractionRef.get()
      const initialData = initialRun.data()
      if (!initialRun.exists || initialData?.status !== 'staging' || initialData.cleanupState) {
        throw new Error('Extraction run is not staged')
      }
      const revision = initialData.sourceRowRevision ?? 0
      const result = await extractionRef.collection('sourceRows').get()
      const rows = result.docs.map((row) => {
        const data = { ...row.data() }
        delete data.fingerprint
        return data as unknown as BoqSourceRowV3
      })
      const verified = { count: rows.length, checksum: checksumSourceRows(rows) }
      await db.runTransaction(async (transaction) => {
        const runSnapshot = await transaction.get(extractionRef)
        const runData = runSnapshot.data()
        if (!runSnapshot.exists || runData?.status !== 'staging' || runData.cleanupState) {
          throw new Error('Extraction run is not staged')
        }
        if ((runData.sourceRowRevision ?? 0) !== revision) {
          throw new Error('Extraction source rows changed during verification')
        }
        transaction.update(extractionRef, {
          verifiedSourceRowCount: verified.count,
          verifiedSourceRowChecksum: verified.checksum,
        })
      })
      return verified
    },

    async finalizeBoqAndRun(boq, run) {
      const extractionRef = runRef(run.boqId, run.id)
      const boqRef = db.collection('boqs').doc(run.boqId)
      return db.runTransaction(async (transaction) => {
        const [storedRun, storedBoq] = await Promise.all([
          transaction.get(extractionRef), transaction.get(boqRef),
        ])
        const runData = storedRun.data()
        if (runData?.status === 'ready' && storedBoq.exists) return 'already_finalized'
        if (!storedRun.exists || runData?.status !== 'staging' || runData.cleanupState) {
          throw new Error('Extraction run is not staged')
        }
        if (runData.identityFingerprint !== extractionRunIdentityFingerprint(run)
          || stableCanonicalJson(runData.extractionIdentity) !== stableCanonicalJson(extractionRunIdentity(run))) {
          throw new Error('Extraction run verification metadata changed')
        }
        if (runData.verifiedSourceRowCount !== run.sourceRowCount
          || runData.verifiedSourceRowChecksum !== run.sourceRowChecksum) {
          throw new Error('Extraction run has not passed source-row verification')
        }
        if (storedBoq.exists) throw new Error('Canonical BOQ already exists without matching ready run')
        const timestamp = now().toISOString()
        transaction.create(boqRef, { ...boq, createdAt: timestamp, updatedAt: timestamp })
        transaction.update(extractionRef, { status: 'ready', readyAt: timestamp, updatedAt: timestamp, stagingExpiresAt: null })
        return 'finalized'
      })
    },

    async getReadyImport(boqId, runId) {
      const extractionRef = runRef(boqId, runId)
      const boqRef = db.collection('boqs').doc(boqId)
      const [storedRun, storedBoq] = await Promise.all([extractionRef.get(), boqRef.get()])
      if (!storedRun.exists || storedRun.data()?.status !== 'ready' || !storedBoq.exists) return null
      const snapshot = await snapshots(boqId, runId).orderBy('order', 'asc').get()
      const sections = mergeSectionChunks(snapshot.docs.map((doc) => doc.data() as SectionSnapshotChunk))
      return {
        boq: { id: storedBoq.id, ...storedBoq.data() } as Boq,
        run: { id: storedRun.id, ...storedRun.data(), sections } as unknown as BoqExtractionRun,
      }
    },

    async cleanupStagingIfSafe(boqId, runId) {
      const extractionRef = runRef(boqId, runId)
      const boqRef = db.collection('boqs').doc(boqId)
      const cleanupToken = randomUUID()
      const leaseExpiresAt = new Date(now().getTime() + CLEANUP_LEASE_MS).toISOString()
      const safe = await db.runTransaction(async (transaction) => {
        const [storedRun, storedBoq] = await Promise.all([
          transaction.get(extractionRef), transaction.get(boqRef),
        ])
        const runData = storedRun.data()
        if (!storedRun.exists || runData?.status !== 'staging' || storedBoq.exists) return false
        if (runData.cleanupState === 'deleting') {
          const existingLease = typeof runData.cleanupLeaseExpiresAt === 'string'
            ? Date.parse(runData.cleanupLeaseExpiresAt)
            : Number.NaN
          if (Number.isFinite(existingLease) && existingLease > now().getTime()) return false
        }
        // Mark first, then delete children, then delete the parent. The lease
        // prevents competing retries from deleting a newly recreated run.
        transaction.update(extractionRef, {
          cleanupState: 'deleting',
          cleanupToken,
          cleanupLeaseExpiresAt: leaseExpiresAt,
          cleanupStartedAt: now().toISOString(),
        })
        return true
      })
      if (!safe) return false
      try {
        for (const collectionName of ['sourceRows', 'sectionSnapshots']) {
          while (true) {
            const hasMore = await db.runTransaction(async (transaction) => {
              const [storedRun, storedBoq] = await Promise.all([
                transaction.get(extractionRef), transaction.get(boqRef),
              ])
              const runData = storedRun.data()
              if (!storedRun.exists || storedBoq.exists || runData?.status !== 'staging'
                || runData.cleanupState !== 'deleting' || runData.cleanupToken !== cleanupToken) {
                throw new Error('Extraction cleanup lease lost')
              }
              const page = await transaction.get(extractionRef.collection(collectionName).limit(SOURCE_ROW_BATCH_SIZE))
              if (page.empty) return false
              page.docs.forEach((doc) => transaction.delete(doc.ref))
              transaction.update(extractionRef, {
                cleanupLeaseExpiresAt: new Date(now().getTime() + CLEANUP_LEASE_MS).toISOString(),
              })
              return true
            })
            if (!hasMore) break
          }
        }
        return await db.runTransaction(async (transaction) => {
          const [storedRun, storedBoq] = await Promise.all([
            transaction.get(extractionRef), transaction.get(boqRef),
          ])
          const runData = storedRun.data()
          if (!storedRun.exists || storedBoq.exists || runData?.status !== 'staging'
            || runData.cleanupState !== 'deleting' || runData.cleanupToken !== cleanupToken) return false
          transaction.delete(extractionRef)
          return true
        })
      } catch (error) {
        // Release only our own lease as retryable state while preserving the
        // parent and any child evidence that remains.
        try {
          await db.runTransaction(async (transaction) => {
            const storedRun = await transaction.get(extractionRef)
            const runData = storedRun.data()
            if (storedRun.exists && runData?.cleanupState === 'deleting' && runData.cleanupToken === cleanupToken) {
              transaction.update(extractionRef, {
                cleanupState: 'cleanup_pending',
                cleanupToken: null,
                cleanupLeaseExpiresAt: null,
              })
            }
          })
        } catch {
          // Preserve the original deletion error; callers will report an
          // uncertain cleanup outcome and keep source storage intact.
        }
        throw error
      }
    },

    async deleteRunTree(boqId, runId) {
      const ref = runRef(boqId, runId)
      for (const collectionName of ['sourceRows', 'sectionSnapshots']) {
        while (true) {
          const page = await ref.collection(collectionName).limit(SOURCE_ROW_BATCH_SIZE).get()
          if (page.empty) break
          const batch = db.batch()
          page.docs.forEach((doc) => batch.delete(doc.ref))
          await batch.commit()
        }
      }
      await ref.delete()
    },

    async listExpiredStagingRuns(cutoff, limit) {
      const result = await db.collectionGroup('extractionRuns')
        .where('status', '==', 'staging')
        .where('stagingExpiresAt', '<=', cutoff)
        .limit(limit)
        .get()
      return result.docs.flatMap((snapshot) => {
        const boqRef = snapshot.ref.parent.parent
        return boqRef ? [{ boqId: boqRef.id, runId: snapshot.id }] : []
      })
    },
  }
}
