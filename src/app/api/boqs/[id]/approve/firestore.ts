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
    const [boqSnap, standardsSnap, settingsSnap, approvedSnap] = await Promise.all([
      transaction.get(boqRef),
      transaction.get(db.collection('standards')),
      transaction.get(db.collection('settings').doc(WORKSPACE_SETTINGS_ID)),
      transaction.get(db.collection('boqs').where('status', '==', 'approved')),
    ])
    if (!boqSnap.exists) return null
    const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
    const approvedQuotes = approvedSnap.docs.filter((doc) => doc.id !== id).map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)
    // Quotes imported before the file fingerprint was stored: use the one on their extraction run.
    await Promise.all([boq, ...approvedQuotes].map(async (quote) => {
      if (quote.sourceDigest || !quote.activeExtractionRunId) return
      const run = await transaction.get(db.collection('boqs').doc(quote.id).collection('extractionRuns').doc(quote.activeExtractionRunId))
      const digest = run.exists ? run.data()?.sourceDigest : undefined
      if (typeof digest === 'string' && digest.startsWith('sha256:')) quote.sourceDigest = digest
    }))
    const standards = standardsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as StandardEntry)
    const settings = fromStoredSettings(settingsSnap.exists ? (settingsSnap.data() as StoredWorkspaceSettings | undefined) : null)
    const result = plan({ boq, standards, unitMap: settings.fuzzy.unitMap ?? {}, approvedQuotes })
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
