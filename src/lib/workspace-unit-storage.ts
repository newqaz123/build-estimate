import { runTransaction } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import {
  fromStoredSettings,
  type StoredWorkspaceSettings,
  WORKSPACE_SETTINGS_ID,
} from '@/lib/settings-storage'
import {
  mapUnitUsage,
  mergeWorkspaceUnit,
  removeWorkspaceUnit,
  renameWorkspaceUnit,
} from '@/lib/units'

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

export interface WorkspaceUnitCascadeDocument {
  readSettings(): Promise<unknown | null>
  writeSettings(patch: Record<string, unknown>): void
  readAllBoqs(): Promise<Array<{ id: string; data: unknown }>>
  writeBoq(id: string, patch: Record<string, unknown>): void
}

export type CascadeRunner = <T>(
  work: (document: WorkspaceUnitCascadeDocument) => Promise<T>,
) => Promise<T>

export function createWorkspaceUnitCascadeStore(runCascade: CascadeRunner) {
  return {
    async remove(unit: string) {
      return runCascade(async (document) => {
        const current = fromStoredSettings(
          (await document.readSettings()) as StoredWorkspaceSettings | null,
        )
        const customUnits = removeWorkspaceUnit(current.units.customUnits, unit)
        document.writeSettings({ units: { customUnits } })
        return { customUnits }
      })
    },
    async rename(oldUnit: string, newUnit: string) {
      return runCascade(async (document) => {
        // Firestore transactions require ALL reads before ANY writes. Both the
        // settings read and the BOQ read must therefore complete before the
        // settings/BOQ writes begin; interleaving them throws a 500 at runtime.
        const renamed = newUnit.trim()
        const isNoOp = renamed === oldUnit

        const current = fromStoredSettings(
          (await document.readSettings()) as StoredWorkspaceSettings | null,
        )
        const { customUnits } = renameWorkspaceUnit(current.units.customUnits, oldUnit, newUnit)

        // A rename to the same canonical value is a no-op success: the
        // customUnits list is already unchanged, so skip the BOQ read+writes
        // entirely to avoid needlessly bumping each BOQ's `updatedAt`. This
        // settings-only read-then-write still satisfies the read-before-write
        // rule.
        if (isNoOp) {
          document.writeSettings({ units: { customUnits } })
          return { customUnits, updatedBoqs: 0, updatedItems: 0 }
        }

        const boqs = (await document.readAllBoqs()) as Array<{ id: string; data: Boq }>
        let updatedBoqs = 0
        let updatedItems = 0
        const touchedBoqs: Array<{ id: string; sections: Boq['sections'] }> = []
        for (const { id, data } of boqs) {
          let touched = false
          const sections = data.sections.map((section) => ({
            ...section,
            items: section.items.map((item) => {
              if (item.pricingRole === 'bundle_child') return item
              if (item.unit === oldUnit) {
                touched = true
                updatedItems += 1
                return { ...item, unit: renamed }
              }
              return item
            }),
          }))
          if (touched) {
            updatedBoqs += 1
            touchedBoqs.push({ id, sections })
          }
        }
        // All reads (settings + BOQs) are complete; now the writes, in order.
        document.writeSettings({ units: { customUnits } })
        for (const { id, sections } of touchedBoqs) {
          document.writeBoq(id, { sections, updatedAt: new Date().toISOString() })
        }
        return { customUnits, updatedBoqs, updatedItems }
      })
    },
    async countUsage(unit: string) {
      return runCascade(async (document) => {
        const boqs = (await document.readAllBoqs()) as Array<{ data: Boq }>
        return mapUnitUsage(boqs.map(({ data }) => data))[unit] ?? 0
      })
    },
  }
}

/**
 * Production cascade runner: settings + all BOQs read/written inside one
 * `runTransaction`. Reads use the transaction for consistency.
 */
const productionCascadeRunner: CascadeRunner = (work) =>
  runTransaction(async (transaction, db) => {
    const settingsRef = db.collection('settings').doc(WORKSPACE_SETTINGS_ID)
    const boqsCollection = db.collection('boqs')
    return work({
      readSettings: async () => {
        const snap = await transaction.get(settingsRef)
        return snap.exists ? snap.data() : null
      },
      writeSettings: (patch) => {
        transaction.set(settingsRef, patch, { merge: true })
      },
      readAllBoqs: async () => {
        const snap = await transaction.get(boqsCollection)
        return snap.docs.map((d) => ({ id: d.id, data: d.data() }))
      },
      writeBoq: (id, patch) => {
        transaction.update(db.collection('boqs').doc(id), patch)
      },
    })
  })

const cascadeStore = createWorkspaceUnitCascadeStore(productionCascadeRunner)

export const removeWorkspaceUnitAtomically = cascadeStore.remove
export const renameWorkspaceUnitAtomically = cascadeStore.rename
export const countWorkspaceUnitUsage = cascadeStore.countUsage
