import { getDb as _getDb } from './firebase-admin'
export const getDb = _getDb
import type { WhereFilterOp } from 'firebase-admin/firestore'

export async function runTransaction<T>(
  work: (transaction: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore) => Promise<T>,
): Promise<T> {
  const db = getDb()
  return db.runTransaction((transaction) => work(transaction, db))
}

export async function getCollection<T>(collection: string): Promise<T[]> {
  const db = getDb()
  const snap = await db.collection(collection).get()
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as T)
}

export async function getCollectionWhere<T>(collection: string, field: string, op: WhereFilterOp, value: unknown): Promise<T[]> {
  const db = getDb()
  const snap = await db.collection(collection).where(field, op, value).get()
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as T)
}

export async function getDocument<T>(collection: string, id: string): Promise<T | null> {
  const db = getDb()
  const doc = await db.collection(collection).doc(id).get()
  if (!doc.exists) return null
  return { id: doc.id, ...doc.data() } as T
}

export async function createDocument(collection: string, data: Record<string, unknown>): Promise<string> {
  const db = getDb()
  const ref = db.collection(collection).doc()
  await ref.set({ ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  return ref.id
}

export async function createDocumentWithId(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  const db = getDb()
  await db.collection(collection).doc(id).set({ ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
}

export async function updateDocument(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  const db = getDb()
  await db.collection(collection).doc(id).update({ ...data, updatedAt: new Date().toISOString() })
}

export async function setDocument(collection: string, id: string, data: Record<string, unknown>, merge = true): Promise<void> {
  const db = getDb()
  await db.collection(collection).doc(id).set({ ...data, updatedAt: new Date().toISOString() }, { merge })
}

export async function deleteDocument(collection: string, id: string): Promise<void> {
  const db = getDb()
  await db.collection(collection).doc(id).delete()
}

type OrderDirection = 'asc' | 'desc'

interface QueryOptions {
  orderByField?: string
  orderDirection?: OrderDirection
  where?: { field: string; op: WhereFilterOp; value: unknown }[]
  limit?: number
}

export async function queryCollection<T>(collection: string, options: QueryOptions = {}): Promise<{ docs: T[]; total: number }> {
  const db = getDb()
  let query: FirebaseFirestore.Query = db.collection(collection)

  if (options.orderByField) {
    query = query.orderBy(options.orderByField, options.orderDirection || 'asc')
  }

  if (options.where) {
    for (const w of options.where) {
      query = query.where(w.field, w.op, w.value)
    }
  }

  if (options.limit) {
    query = query.limit(options.limit)
  }

  const snapshot = await query.get()
  const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }) as T)
  return { docs, total: docs.length }
}
