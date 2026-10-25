import { auth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { findDuplicatesOfQuoteInFirestore } from '@/lib/boq-duplicate-lookup'
import { createDuplicatesGetHandler } from './handler'

export const GET = createDuplicatesGetHandler({
  authenticate: auth,
  findDuplicates: (id) => findDuplicatesOfQuoteInFirestore(getDb(), id),
})
