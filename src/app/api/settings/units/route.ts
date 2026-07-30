import { auth } from '@/lib/auth'
import { addWorkspaceUnitAtomically } from '@/lib/workspace-unit-storage'
import { createWorkspaceUnitsPostHandler } from './handler'

export const POST = createWorkspaceUnitsPostHandler({
  authenticate: auth,
  addUnit: addWorkspaceUnitAtomically,
})
