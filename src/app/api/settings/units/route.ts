import { auth } from '@/lib/auth'
import { getDocument } from '@/lib/db'
import {
  addWorkspaceUnitAtomically,
  removeWorkspaceUnitAtomically,
  renameWorkspaceUnitAtomically,
  countWorkspaceUnitUsage,
} from '@/lib/workspace-unit-storage'
import { WORKSPACE_SETTINGS_ID } from '@/lib/settings-storage'
import {
  createWorkspaceUnitsPostHandler,
  createWorkspaceUnitsGetHandler,
  createWorkspaceUnitsDeleteHandler,
  createWorkspaceUnitsPatchHandler,
} from './handler'

export const POST = createWorkspaceUnitsPostHandler({
  authenticate: auth,
  addUnit: addWorkspaceUnitAtomically,
})

export const GET = createWorkspaceUnitsGetHandler({
  authenticate: auth,
  readSettings: () => getDocument('settings', WORKSPACE_SETTINGS_ID),
  readAllBoqs: async () => {
    const db = (await import('@/lib/firebase-admin')).getDb()
    const snap = await db.collection('boqs').get()
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }))
  },
})

export const DELETE = createWorkspaceUnitsDeleteHandler({
  authenticate: auth,
  countUsage: countWorkspaceUnitUsage,
  removeUnit: removeWorkspaceUnitAtomically,
})

export const PATCH = createWorkspaceUnitsPatchHandler({
  authenticate: auth,
  renameUnit: renameWorkspaceUnitAtomically,
})
