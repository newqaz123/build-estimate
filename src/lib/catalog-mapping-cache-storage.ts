import type { Firestore } from 'firebase-admin/firestore'
import {
  isHashedCatalogMappingCacheKey,
  toApprovedCatalogMapping,
  type ApprovedCatalogMapping,
  type CatalogMappingCache,
  type CatalogMappingOrigin,
  type CatalogMappingRecord,
} from './catalog-mapping-cache'
import { getDb } from './db'

export const CATALOG_MAPPING_CACHE_COLLECTION = 'catalogMappingCache'

const MAPPING_KEYS = new Set([
  'sourceSignature',
  'catalogId',
  'conversionRuleId',
  'approvedBy',
  'approvedAt',
  'origin',
])

export class CatalogMappingCacheStorageError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CatalogMappingCacheStorageError'
    this.status = status
  }
}

/**
 * Document adapter with one atomic compare/write primitive.
 * Firestore implementations must use transactions for runAtomic.
 */
export interface CatalogMappingDocumentStore {
  get(id: string): Promise<{ id: string; data: Record<string, unknown> } | null>
  delete(id: string): Promise<void>
  /**
   * Atomically read current document data (or null), decide next state.
   * Return `null` from mutate to skip the write and preserve the current value.
   */
  runAtomic(
    id: string,
    mutate: (current: Record<string, unknown> | null) => Record<string, unknown> | null,
  ): Promise<'applied' | 'skipped'>
}

/**
 * Concrete store: exact public cache interface plus explicit model-write path.
 * Model writes are never available through CatalogMappingCache.put.
 */
export interface CatalogMappingCacheStore extends CatalogMappingCache {
  putModel(key: string, mapping: ApprovedCatalogMapping): Promise<void>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function requireKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CatalogMappingCacheStorageError(
        `Invalid ${label}: unexpected key "${key}".`,
      )
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogMappingCacheStorageError(`Invalid ${label}.`)
  }
  return value.trim()
}

function assertHashedKey(key: string): string {
  if (!isHashedCatalogMappingCacheKey(key)) {
    throw new CatalogMappingCacheStorageError(
      'Mapping cache key must be a sha256 hash.',
    )
  }
  return key
}

function parseOrigin(value: unknown): CatalogMappingOrigin {
  if (value !== 'human' && value !== 'model') {
    throw new CatalogMappingCacheStorageError('Invalid mapping origin.')
  }
  return value
}

/**
 * Fail-closed parser for stored catalog mapping cache documents.
 */
export function parseCatalogMappingRecord(value: unknown): CatalogMappingRecord {
  if (!isPlainRecord(value)) {
    throw new CatalogMappingCacheStorageError('Invalid mapping cache document.')
  }
  requireKeys(value, MAPPING_KEYS, 'mapping cache document')

  const parsed: CatalogMappingRecord = {
    sourceSignature: nonEmptyString(value.sourceSignature, 'sourceSignature'),
    catalogId: nonEmptyString(value.catalogId, 'catalogId'),
    approvedBy: nonEmptyString(value.approvedBy, 'approvedBy'),
    approvedAt: nonEmptyString(value.approvedAt, 'approvedAt'),
    origin: parseOrigin(value.origin),
  }
  if (value.conversionRuleId !== undefined) {
    parsed.conversionRuleId = nonEmptyString(value.conversionRuleId, 'conversionRuleId')
  }
  return parsed
}

function parseApprovedMappingInput(value: unknown): ApprovedCatalogMapping {
  if (!isPlainRecord(value)) {
    throw new CatalogMappingCacheStorageError('Invalid approved catalog mapping.')
  }
  // Reject unknown keys including conversion factors / model payloads.
  const allowed = new Set([
    'sourceSignature',
    'catalogId',
    'conversionRuleId',
    'approvedBy',
    'approvedAt',
  ])
  requireKeys(value, allowed, 'approved catalog mapping')

  const parsed: ApprovedCatalogMapping = {
    sourceSignature: nonEmptyString(value.sourceSignature, 'sourceSignature'),
    catalogId: nonEmptyString(value.catalogId, 'catalogId'),
    approvedBy: nonEmptyString(value.approvedBy, 'approvedBy'),
    approvedAt: nonEmptyString(value.approvedAt, 'approvedAt'),
  }
  if (value.conversionRuleId !== undefined) {
    parsed.conversionRuleId = nonEmptyString(value.conversionRuleId, 'conversionRuleId')
  }
  return parsed
}

function toStoredDocument(record: CatalogMappingRecord): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    sourceSignature: record.sourceSignature,
    catalogId: record.catalogId,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
    origin: record.origin,
  }
  if (record.conversionRuleId !== undefined) {
    doc.conversionRuleId = record.conversionRuleId
  }
  return doc
}

function existingOrigin(current: Record<string, unknown> | null): CatalogMappingOrigin | null {
  if (!current) return null
  try {
    return parseCatalogMappingRecord(current).origin
  } catch {
    // Corrupt/unknown documents are treated as absent for overwrite decisions only
    // after parse failure on write paths that re-validate next payload.
    return null
  }
}

export function createCatalogMappingCacheStore(
  documents: CatalogMappingDocumentStore,
): CatalogMappingCacheStore {
  async function writeOrigin(
    key: string,
    mapping: ApprovedCatalogMapping,
    origin: CatalogMappingOrigin,
  ): Promise<void> {
    const cacheKey = assertHashedKey(key)
    const approved = parseApprovedMappingInput(mapping)
    const next = toStoredDocument({
      ...approved,
      origin,
    })

    await documents.runAtomic(cacheKey, (current) => {
      if (origin === 'model' && existingOrigin(current) === 'human') {
        // Preserve human-approved mapping against model advice.
        return null
      }
      return next
    })
  }

  return {
    async get(key: string): Promise<ApprovedCatalogMapping | null> {
      const cacheKey = assertHashedKey(key)
      const snapshot = await documents.get(cacheKey)
      if (!snapshot) return null
      const record = parseCatalogMappingRecord(snapshot.data)
      // Only mappings a person approved count as approved history. Legacy
      // model-advice documents stay in storage but are never served as approved,
      // so they cannot be ranked as approved_history or skip review.
      if (record.origin !== 'human') return null
      return toApprovedCatalogMapping(record)
    },

    /** Explicit human approval write. */
    async put(key: string, mapping: ApprovedCatalogMapping): Promise<void> {
      await writeOrigin(key, mapping, 'human')
    },

    /** Explicit model-advice write; never overwrites human. */
    async putModel(key: string, mapping: ApprovedCatalogMapping): Promise<void> {
      await writeOrigin(key, mapping, 'model')
    },

    async remove(key: string): Promise<void> {
      const cacheKey = assertHashedKey(key)
      await documents.delete(cacheKey)
    },
  }
}

export function createFirestoreCatalogMappingDocuments(
  db: Firestore = getDb(),
): CatalogMappingDocumentStore {
  const collection = () => db.collection(CATALOG_MAPPING_CACHE_COLLECTION)

  return {
    async get(id) {
      const snap = await collection().doc(id).get()
      if (!snap.exists) return null
      return { id: snap.id, data: (snap.data() ?? {}) as Record<string, unknown> }
    },
    async delete(id) {
      await collection().doc(id).delete()
    },
    async runAtomic(id, mutate) {
      return db.runTransaction(async (transaction) => {
        const ref = collection().doc(id)
        const snap = await transaction.get(ref)
        const current = snap.exists
          ? ((snap.data() ?? {}) as Record<string, unknown>)
          : null
        const next = mutate(current)
        if (next === null) return 'skipped' as const
        transaction.set(ref, next)
        return 'applied' as const
      })
    },
  }
}

export function createFirestoreCatalogMappingCacheStore(
  db: Firestore = getDb(),
): CatalogMappingCacheStore {
  return createCatalogMappingCacheStore(createFirestoreCatalogMappingDocuments(db))
}
