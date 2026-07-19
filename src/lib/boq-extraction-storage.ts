import type { Boq } from './boq-schema'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import type { Firestore } from 'firebase-admin/firestore'
import {
  checksumSourceRows,
  fingerprintParserConfig,
  stableSourceRowFingerprint,
  type BoqExtractionRun,
} from './boq-extraction-run'

const SOURCE_ROW_BATCH_SIZE = 200
const SECTION_ITEM_CHUNK_SIZE = 100

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
  createRun(run: BoqExtractionRun): Promise<'created' | 'exists_staging' | 'exists_ready'>
  writeSourceRows(boqId: string, runId: string, rows: readonly BoqSourceRowV3[]): Promise<void>
  verifySourceRows(boqId: string, runId: string): Promise<{ count: number; checksum: string }>
  finalizeBoqAndRun(
    boq: Omit<Boq, 'createdAt' | 'updatedAt'>,
    run: BoqExtractionRun,
  ): Promise<'finalized' | 'already_finalized'>
  getReadyImport(boqId: string, runId: string): Promise<{ boq: Boq; run: BoqExtractionRun } | null>
  deleteRunTree(boqId: string, runId: string): Promise<void>
  listExpiredStagingRuns(cutoff: string, limit: number): Promise<Array<{ boqId: string; runId: string }>>
}

export class ExtractionCleanupUncertainError extends Error {
  constructor() {
    super('Extraction staging cleanup outcome is unknown; recovery evidence was preserved')
    this.name = 'ExtractionCleanupUncertainError'
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Extraction persistence cancelled')
}

function isMatchingReadyImport(
  value: { boq: Boq; run: BoqExtractionRun } | null,
  boqId: string,
  runId: string,
): value is { boq: Boq; run: BoqExtractionRun } {
  return value?.boq?.id === boqId
    && value.run?.id === runId
    && value.run.boqId === boqId
    && value.run.status === 'ready'
}

async function cleanupOrThrow(store: ExtractionStore, boqId: string, runId: string): Promise<void> {
  try {
    await store.deleteRunTree(boqId, runId)
  } catch {
    throw new ExtractionCleanupUncertainError()
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
  let staged = false
  try {
    // Creation can commit and still reject. Treat its outcome as potentially
    // staged until nested cleanup proves otherwise.
    staged = true
    const creation = await store.createRun(input.run)
    if (!['created', 'exists_staging', 'exists_ready'].includes(creation)) {
      throw new Error('Extraction store result was malformed')
    }
    if (creation === 'exists_ready') {
      const existing = await store.getReadyImport(input.run.boqId, input.run.id)
      if (isMatchingReadyImport(existing, input.run.boqId, input.run.id)) return existing.boq
      throw new Error('Extraction ready-state reconciliation failed')
    }
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
      await store.finalizeBoqAndRun(input.boq, input.run)
      return input.boq
    } catch (finalizeError) {
      try {
        const existing = await store.getReadyImport(input.run.boqId, input.run.id)
        if (isMatchingReadyImport(existing, input.run.boqId, input.run.id)) return existing.boq
      } catch {
        // A failed reconciliation still enters conservative run-tree cleanup.
      }
      throw finalizeError
    }
  } catch (error) {
    if (staged) await cleanupOrThrow(store, input.run.boqId, input.run.id)
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
  for (const run of expired) await store.deleteRunTree(run.boqId, run.runId)
  return expired.length
}

function sectionChunks(run: BoqExtractionRun) {
  const chunks: Array<{ order: number; sections: BoqExtractionRun['sections'] }> = []
  for (const section of run.sections) {
    if (section.items.length === 0) {
      chunks.push({ order: chunks.length, sections: [{ header: section.header, items: [] }] })
      continue
    }
    for (let index = 0; index < section.items.length; index += SECTION_ITEM_CHUNK_SIZE) {
      chunks.push({
        order: chunks.length,
        sections: [{ header: section.header, items: section.items.slice(index, index + SECTION_ITEM_CHUNK_SIZE) }],
      })
    }
  }
  return chunks
}

function mergeSectionChunks(chunks: Array<{ order: number; sections: BoqExtractionRun['sections'] }>): BoqExtractionRun['sections'] {
  const sections: BoqExtractionRun['sections'] = []
  for (const chunk of chunks.sort((left, right) => left.order - right.order)) {
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
          if (data?.boqId !== run.boqId || data?.sourceRowChecksum !== run.sourceRowChecksum) {
            throw new Error('Extraction run identity conflict')
          }
          if (data?.status === 'ready') return 'exists_ready'
          if (data?.status === 'staging') return 'exists_staging'
          throw new Error('Extraction run has an unsupported state')
        }
        const chunks = sectionChunks(run)
        if (chunks.length > 400) throw new Error('Extraction section snapshot exceeds the supported chunk count')
        const metadata = Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'sections'))
        transaction.create(ref, {
          ...metadata,
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
      const existing = refs.length > 0 ? await db.getAll(...refs) : []
      const batch = db.batch()
      rows.forEach((row, index) => {
        const snapshot = existing[index]
        if (snapshot?.exists) {
          if (snapshot.data()?.fingerprint !== stableSourceRowFingerprint(row)) {
            throw new Error('Extraction source-row identity conflict')
          }
          return
        }
        batch.create(refs[index], { ...row, fingerprint: stableSourceRowFingerprint(row) })
      })
      await batch.commit()
    },

    async verifySourceRows(boqId, runId) {
      const result = await runRef(boqId, runId).collection('sourceRows').get()
      const rows = result.docs.map((row) => {
        const data = { ...row.data() }
        delete data.fingerprint
        return data as unknown as BoqSourceRowV3
      })
      const verified = { count: rows.length, checksum: checksumSourceRows(rows) }
      await runRef(boqId, runId).update({
        verifiedSourceRowCount: verified.count,
        verifiedSourceRowChecksum: verified.checksum,
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
        if (!storedRun.exists || runData?.status !== 'staging') throw new Error('Extraction run is not staged')
        if (runData.sourceRowCount !== run.sourceRowCount || runData.sourceRowChecksum !== run.sourceRowChecksum) {
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
      const sections = mergeSectionChunks(snapshot.docs.map((doc) => doc.data() as { order: number; sections: BoqExtractionRun['sections'] }))
      return {
        boq: { id: storedBoq.id, ...storedBoq.data() } as Boq,
        run: { id: storedRun.id, ...storedRun.data(), sections } as unknown as BoqExtractionRun,
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
