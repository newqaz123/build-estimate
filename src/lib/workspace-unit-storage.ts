import { runTransaction } from '@/lib/db'
import {
  fromStoredSettings,
  type StoredWorkspaceSettings,
  WORKSPACE_SETTINGS_ID,
} from '@/lib/settings-storage'
import { mergeWorkspaceUnit } from '@/lib/units'

/**
 * Narrow adapter over the workspace settings document, used so the
 * concurrency of the store can be tested without importing Firestore.
 *
 * `read` returns the raw stored document (or null when absent); `write`
 * stages a merge patch. Both must run inside the same transaction callback.
 */
export interface WorkspaceSettingsAtomicDocument {
  read(): Promise<unknown | null>
  write(patch: Record<string, unknown>): void
}

/**
 * Runs `work` against the settings document inside a single atomic unit of
 * work. The read and the write happen within the same callback and must not
 * be separated, or concurrent additions could be lost.
 */
export type WorkspaceSettingsTransactionRunner = <T>(
  work: (document: WorkspaceSettingsAtomicDocument) => Promise<T>,
) => Promise<T>

export function createWorkspaceUnitStore(
  runAtomic: WorkspaceSettingsTransactionRunner,
) {
  return {
    async add(raw: unknown) {
      return runAtomic(async (document) => {
        const current = fromStoredSettings(
          (await document.read()) as StoredWorkspaceSettings | null,
        )
        const result = mergeWorkspaceUnit(current.units.customUnits, raw)
        document.write({
          units: { customUnits: result.customUnits },
        })
        return result
      })
    },
  }
}

/**
 * Production runner: the Firestore read and the merge write happen inside one
 * `runTransaction` callback. The document reference is created lazily inside
 * the callback so neither a separate pre-transaction read nor a full-settings
 * replacement is ever performed.
 */
const productionRunner: WorkspaceSettingsTransactionRunner = (work) =>
  runTransaction(async (transaction, db) => {
    const reference = db
      .collection('settings')
      .doc(WORKSPACE_SETTINGS_ID)

    return work({
      read: async () => {
        const snapshot = await transaction.get(reference)
        return snapshot.exists ? snapshot.data() : null
      },
      write: (patch) => {
        transaction.set(reference, patch, { merge: true })
      },
    })
  })

export const addWorkspaceUnitAtomically =
  createWorkspaceUnitStore(productionRunner).add
