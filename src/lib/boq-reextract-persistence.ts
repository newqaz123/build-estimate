import type { Firestore } from 'firebase-admin/firestore'
import type { BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import { createFirestoreExtractionStore, extractionRunPath, type ExtractionStore } from './boq-extraction-storage'

const SOURCE_ROW_BATCH_SIZE = 200

/** Stages evidence like import, but intentionally never creates or updates `boqs/{id}`. */
export async function persistReextractedRun(
  input: { run: BoqExtractionRun; rows: readonly BoqSourceRowV3[] },
  store: ExtractionStore,
  finalizeRun: (run: BoqExtractionRun) => Promise<void>,
): Promise<BoqExtractionRun> {
  const created = await store.createRun(input.run)
  if (created !== 'created') throw new Error(`Re-extraction run already exists (${created})`)
  for (let index = 0; index < input.rows.length; index += SOURCE_ROW_BATCH_SIZE) {
    await store.writeSourceRows(input.run.boqId, input.run.id, input.rows.slice(index, index + SOURCE_ROW_BATCH_SIZE))
  }
  const verified = await store.verifySourceRows(input.run.boqId, input.run.id)
  if (verified.count !== input.run.sourceRowCount || verified.checksum !== input.run.sourceRowChecksum) {
    throw new Error('Re-extraction source-row verification failed')
  }
  await finalizeRun(input.run)
  return { ...input.run, status: 'ready', readyAt: new Date().toISOString(), stagingExpiresAt: null }
}

export function createFirestoreReextractionPersistence(db: Firestore, now: () => Date = () => new Date()) {
  const store = createFirestoreExtractionStore(db, now)
  return async (input: { run: BoqExtractionRun; rows: readonly BoqSourceRowV3[] }): Promise<BoqExtractionRun> =>
    persistReextractedRun(input, store, async (run) => {
      const ref = db.doc(extractionRunPath(run.boqId, run.id))
      const boqRef = db.collection('boqs').doc(run.boqId)
      await db.runTransaction(async (transaction) => {
        const [snapshot, boqSnapshot] = await Promise.all([transaction.get(ref), transaction.get(boqRef)])
        const data = snapshot.data()
        if (!snapshot.exists || data?.status !== 'staging' || data.cleanupState || !boqSnapshot.exists) throw new Error('Re-extraction run is not staged')
        if (data.verifiedSourceRowCount !== run.sourceRowCount || data.verifiedSourceRowChecksum !== run.sourceRowChecksum) {
          throw new Error('Re-extraction run has not passed source-row verification')
        }
        const timestamp = now().toISOString()
        transaction.update(ref, { status: 'ready', readyAt: timestamp, updatedAt: timestamp, stagingExpiresAt: null })
        // Persist only discovery metadata; never write parsed sections or parsed
        // document metadata into the user's saved canonical BOQ.
        transaction.update(boqRef, { activeExtractionRunId: run.id, updatedAt: timestamp })
      })
    })
}
