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

export interface CatalogMappingDocumentStore {
  get(id: string): Promise<{ id: string; data: Record<string, unknown> } | null>
  set(id: string, data: Record<string, unknown>): Promise<void>
  update(id: string, data: Record<string, unknown>): Promise<void>
  delete(id: string): Promise<void>
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

export function createCatalogMappingCacheStore(
  documents: CatalogMappingDocumentStore,
): CatalogMappingCache {
  return {
    async get(key: string): Promise<ApprovedCatalogMapping | null> {
      const cacheKey = assertHashedKey(key)
      const snapshot = await documents.get(cacheKey)
      if (!snapshot) return null
      const record = parseCatalogMappingRecord(snapshot.data)
      return toApprovedCatalogMapping(record)
    },

    async put(
      key: string,
      mapping: ApprovedCatalogMapping,
      options: { origin?: CatalogMappingOrigin } = {},
    ): Promise<void> {
      const cacheKey = assertHashedKey(key)
      const origin = options.origin ?? 'human'
      const approved = parseApprovedMappingInput(mapping)
      const next: CatalogMappingRecord = {
        ...approved,
        origin,
      }

      const existingSnap = await documents.get(cacheKey)
      if (!existingSnap) {
        await documents.set(cacheKey, toStoredDocument(next))
        return
      }

      const existing = parseCatalogMappingRecord(existingSnap.data)
      // Human-approved mappings cannot be overwritten by model-only advice.
      if (existing.origin === 'human' && origin === 'model') {
        return
      }

      await documents.update(cacheKey, toStoredDocument(next))
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
    async set(id, data) {
      const ref = collection().doc(id)
      const existing = await ref.get()
      if (existing.exists) {
        throw new CatalogMappingCacheStorageError('Mapping cache entry already exists.', 409)
      }
      await ref.set(data)
    },
    async update(id, data) {
      const ref = collection().doc(id)
      const existing = await ref.get()
      if (!existing.exists) {
        throw new CatalogMappingCacheStorageError('Mapping cache entry not found.', 404)
      }
      await ref.set(data)
    },
    async delete(id) {
      await collection().doc(id).delete()
    },
  }
}

export function createFirestoreCatalogMappingCacheStore(
  db: Firestore = getDb(),
): CatalogMappingCache {
  return createCatalogMappingCacheStore(createFirestoreCatalogMappingDocuments(db))
}
