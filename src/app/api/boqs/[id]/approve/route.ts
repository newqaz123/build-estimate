import { approvalHandlers } from './firestore'

/** One-step Approve: saves edits and catalog choices, then adds the quote to price history. */
export const POST = approvalHandlers.approve
