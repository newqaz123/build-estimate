import { createHash } from 'node:crypto'

import type { Boq } from './boq-schema'
import { findDuplicateQuotes, findSameFile, type DuplicateMatch } from './boq-duplicates'

export async function digestUpload(file: File): Promise<string> {
  return `sha256:${createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex')}`
}

/**
 * All quotes with their file fingerprint. Quotes imported before `sourceDigest` was
 * stored fall back to the digest kept on their active extraction run (read-only).
 */
export async function loadQuotesWithDigest(db: FirebaseFirestore.Firestore): Promise<Boq[]> {
  const snapshot = await db.collection('boqs').get()
  const quotes = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Boq)
  await Promise.all(quotes.map(async (quote) => {
    if (quote.sourceDigest || !quote.activeExtractionRunId) return
    const run = await db.collection('boqs').doc(quote.id).collection('extractionRuns').doc(quote.activeExtractionRunId).get()
    const digest = run.exists ? run.data()?.sourceDigest : undefined
    if (typeof digest === 'string' && digest.startsWith('sha256:')) quote.sourceDigest = digest
  }))
  return quotes
}

export async function findDuplicateUploadsInFirestore(db: FirebaseFirestore.Firestore, file: File): Promise<DuplicateMatch[]> {
  return findSameFile(await digestUpload(file), await loadQuotesWithDigest(db))
}

export async function findDuplicatesOfQuoteInFirestore(db: FirebaseFirestore.Firestore, id: string): Promise<DuplicateMatch[] | null> {
  const quotes = await loadQuotesWithDigest(db)
  const target = quotes.find((quote) => quote.id === id)
  if (!target) return null
  return findDuplicateQuotes(target, quotes)
}
