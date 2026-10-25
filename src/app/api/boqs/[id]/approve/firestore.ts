import { auth } from '@/lib/auth'
import { runTransaction } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { WORKSPACE_SETTINGS_ID, fromStoredSettings, type StoredWorkspaceSettings } from '@/lib/settings-storage'
import { createApprovalHandlers } from './handler'

/** Firestore wiring shared by the approve and reopen routes. */
export const approvalHandlers = createApprovalHandlers({
  authenticate: auth,
  now: () => new Date().toISOString(),
  transact: (id, plan) => runTransaction(async (transaction, db) => {
    const boqRef = db.collection('boqs').doc(id)
    const [boqSnap, standardsSnap, settingsSnap] = await Promise.all([
      transaction.get(boqRef),
      transaction.get(db.collection('standards')),
      transaction.get(db.collection('settings').doc(WORKSPACE_SETTINGS_ID)),
    ])
    if (!boqSnap.exists) return null
    const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
    const standards = standardsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as StandardEntry)
    const settings = fromStoredSettings(settingsSnap.exists ? (settingsSnap.data() as StoredWorkspaceSettings | undefined) : null)
    const result = plan({ boq, standards, unitMap: settings.fuzzy.unitMap ?? {} })
    if ('rejected' in result) return result
    const { id: _boqId, ...boqData } = result.boq
    void _boqId
    // Full overwrite so removed fields (approvedAt on reopen) really disappear.
    transaction.set(boqRef, boqData)
    for (const standard of result.standards) {
      const { id: standardId, historicalPricing: _derived, ...data } = standard
      void _derived
      transaction.set(db.collection('standards').doc(standardId), data)
    }
    return result
  }),
})
