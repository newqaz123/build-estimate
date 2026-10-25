import { approvalHandlers } from '../approve/firestore'

/** Reopen an approved quote for editing; it leaves price history until approved again. */
export const POST = approvalHandlers.reopen
