import type { Firestore } from 'firebase-admin/firestore'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import { parseDecimalString, type DecimalString } from './decimal-string'
import { getDb } from './db'

export const CATALOG_CONVERSION_RULES_COLLECTION = 'catalogConversionRules'

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

const HUMAN_RULE_KEYS = new Set([
  'id',
  'sourceUnit',
  'catalogUnit',
  'catalogUnitsPerSourceUnit',
  'scope',
  'catalogId',
  'version',
  'approvedBy',
  'approvedAt',
  'archivedAt',
])

const CREATE_INPUT_KEYS = new Set([
  'sourceUnit',
  'catalogUnit',
  'catalogUnitsPerSourceUnit',
  'scope',
  'catalogId',
])

export class CatalogConversionStorageError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CatalogConversionStorageError'
    this.status = status
  }
}

export interface CatalogConversionRuleDocumentStore {
  get(id: string): Promise<{ id: string; data: Record<string, unknown> } | null>
  set(id: string, data: Record<string, unknown>): Promise<void>
  update(id: string, patch: Record<string, unknown>): Promise<void>
  list(limit: number): Promise<Array<{ id: string; data: Record<string, unknown> }>>
}

export interface CreateHumanCatalogConversionRuleInput {
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: DecimalString
  scope: 'global' | 'catalog_item'
  catalogId?: string
}

export interface CatalogConversionRuleStoreOptions {
  now?: () => Date
  createId?: () => string
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
      throw new CatalogConversionStorageError(
        `Invalid ${label}: unexpected key "${key}".`,
      )
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogConversionStorageError(`Invalid ${label}.`)
  }
  return value.trim()
}

function parsePositiveFactor(value: unknown): DecimalString {
  let parsed: DecimalString
  try {
    parsed = parseDecimalString(value)
  } catch {
    throw new CatalogConversionStorageError('Invalid conversion factor.')
  }
  if (parsed === '0' || parsed.startsWith('-')) {
    throw new CatalogConversionStorageError('Conversion factor must be positive.')
  }
  return parsed
}

function parsePositiveIntegerVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 1) {
    throw new CatalogConversionStorageError('Conversion rule version must be a positive integer.')
  }
  return value
}

/**
 * Fail-closed parser for stored human-approved conversion rules.
 * Identity rules are never accepted from storage.
 */
export function parseHumanApprovedCatalogConversionRule(
  value: unknown,
): HumanApprovedCatalogConversionRule {
  if (!isPlainRecord(value)) {
    throw new CatalogConversionStorageError('Invalid conversion rule document.')
  }
  requireKeys(value, HUMAN_RULE_KEYS, 'conversion rule')

  if (value.scope === 'identity') {
    throw new CatalogConversionStorageError(
      'Identity conversion rules cannot be stored or loaded as human approvals.',
    )
  }
  if (value.scope !== 'global' && value.scope !== 'catalog_item') {
    throw new CatalogConversionStorageError('Invalid conversion rule scope.')
  }

  const parsed: HumanApprovedCatalogConversionRule = {
    id: nonEmptyString(value.id, 'id'),
    sourceUnit: nonEmptyString(value.sourceUnit, 'sourceUnit'),
    catalogUnit: nonEmptyString(value.catalogUnit, 'catalogUnit'),
    catalogUnitsPerSourceUnit: parsePositiveFactor(value.catalogUnitsPerSourceUnit),
    scope: value.scope,
    version: parsePositiveIntegerVersion(value.version),
    approvedBy: nonEmptyString(value.approvedBy, 'approvedBy'),
    approvedAt: nonEmptyString(value.approvedAt, 'approvedAt'),
  }

  if (value.scope === 'global') {
    if (value.catalogId !== undefined) {
      throw new CatalogConversionStorageError('Global conversion rules must not include catalogId.')
    }
  } else {
    parsed.catalogId = nonEmptyString(value.catalogId, 'catalogId')
  }

  if (value.archivedAt !== undefined) {
    parsed.archivedAt = nonEmptyString(value.archivedAt, 'archivedAt')
  }

  return parsed
}

export function parseCreateHumanCatalogConversionRuleInput(
  value: unknown,
): CreateHumanCatalogConversionRuleInput {
  if (!isPlainRecord(value)) {
    throw new CatalogConversionStorageError('Invalid conversion rule payload.')
  }
  requireKeys(value, CREATE_INPUT_KEYS, 'conversion rule payload')

  if (value.scope === 'identity') {
    throw new CatalogConversionStorageError(
      'Identity conversion rules are system-generated and cannot be created via the API.',
    )
  }
  if (value.scope !== 'global' && value.scope !== 'catalog_item') {
    throw new CatalogConversionStorageError('Invalid conversion rule scope.')
  }

  const input: CreateHumanCatalogConversionRuleInput = {
    sourceUnit: nonEmptyString(value.sourceUnit, 'sourceUnit'),
    catalogUnit: nonEmptyString(value.catalogUnit, 'catalogUnit'),
    catalogUnitsPerSourceUnit: parsePositiveFactor(value.catalogUnitsPerSourceUnit),
    scope: value.scope,
  }

  if (value.scope === 'global') {
    if (value.catalogId !== undefined) {
      throw new CatalogConversionStorageError('Global conversion rules must not include catalogId.')
    }
  } else {
    input.catalogId = nonEmptyString(value.catalogId, 'catalogId')
  }

  return input
}

function toStoredDocument(rule: HumanApprovedCatalogConversionRule): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: rule.id,
    sourceUnit: rule.sourceUnit,
    catalogUnit: rule.catalogUnit,
    catalogUnitsPerSourceUnit: rule.catalogUnitsPerSourceUnit,
    scope: rule.scope,
    version: rule.version,
    approvedBy: rule.approvedBy,
    approvedAt: rule.approvedAt,
  }
  if (rule.catalogId !== undefined) {
    doc.catalogId = rule.catalogId
  }
  if (rule.archivedAt !== undefined) {
    doc.archivedAt = rule.archivedAt
  }
  return doc
}

function assertListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new CatalogConversionStorageError(
      `List limit must be between 1 and ${MAX_LIST_LIMIT}.`,
    )
  }
  return limit
}

export function createCatalogConversionRuleStore(
  documents: CatalogConversionRuleDocumentStore,
  options: CatalogConversionRuleStoreOptions = {},
) {
  const now = options.now ?? (() => new Date())
  const createId = options.createId ?? (() => crypto.randomUUID())

  return {
    async create(
      rawInput: unknown,
      meta: { actorId: string },
    ): Promise<HumanApprovedCatalogConversionRule> {
      const actorId = nonEmptyString(meta.actorId, 'actorId')
      const input = parseCreateHumanCatalogConversionRuleInput(rawInput)
      const id = createId()
      if (id.startsWith('identity:')) {
        throw new CatalogConversionStorageError(
          'Identity conversion rule ids cannot be stored as human approvals.',
        )
      }

      const rule: HumanApprovedCatalogConversionRule = {
        id,
        sourceUnit: input.sourceUnit,
        catalogUnit: input.catalogUnit,
        catalogUnitsPerSourceUnit: input.catalogUnitsPerSourceUnit,
        scope: input.scope,
        version: 1,
        approvedBy: actorId,
        approvedAt: now().toISOString(),
      }
      if (input.catalogId !== undefined) {
        rule.catalogId = input.catalogId
      }

      // Re-parse to enforce the same fail-closed invariants used for reads.
      const validated = parseHumanApprovedCatalogConversionRule(rule)
      await documents.set(validated.id, toStoredDocument(validated))
      return validated
    },

    async get(id: string): Promise<HumanApprovedCatalogConversionRule | null> {
      const ruleId = nonEmptyString(id, 'id')
      if (ruleId.startsWith('identity:')) {
        throw new CatalogConversionStorageError(
          'Identity conversion rules are not stored as documents.',
        )
      }
      const snapshot = await documents.get(ruleId)
      if (!snapshot) return null
      return parseHumanApprovedCatalogConversionRule({
        ...snapshot.data,
        id: snapshot.id,
      })
    },

    async list(options: { limit?: number } = {}): Promise<HumanApprovedCatalogConversionRule[]> {
      const limit = assertListLimit(options.limit ?? DEFAULT_LIST_LIMIT)
      const rows = await documents.list(limit)
      return rows.map((row) => parseHumanApprovedCatalogConversionRule({
        ...row.data,
        id: row.id,
      }))
    },

    async archive(
      id: string,
      meta: { actorId: string; archivedAt?: string } = { actorId: 'system' },
    ): Promise<HumanApprovedCatalogConversionRule> {
      nonEmptyString(meta.actorId, 'actorId')
      const ruleId = nonEmptyString(id, 'id')
      if (ruleId.startsWith('identity:')) {
        throw new CatalogConversionStorageError(
          'Identity conversion rules cannot be archived because they are not stored.',
        )
      }

      const existing = await this.get(ruleId)
      if (!existing) {
        throw new CatalogConversionStorageError('Conversion rule not found.', 404)
      }
      if (existing.archivedAt !== undefined) {
        return existing
      }

      const archivedAt = meta.archivedAt
        ? nonEmptyString(meta.archivedAt, 'archivedAt')
        : now().toISOString()
      await documents.update(ruleId, { archivedAt })
      return {
        ...existing,
        archivedAt,
      }
    },
  }
}

export type CatalogConversionRuleStore = ReturnType<typeof createCatalogConversionRuleStore>

export function createFirestoreCatalogConversionDocuments(
  db: Firestore = getDb(),
): CatalogConversionRuleDocumentStore {
  const collection = () => db.collection(CATALOG_CONVERSION_RULES_COLLECTION)

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
        throw new CatalogConversionStorageError('Conversion rule already exists.', 409)
      }
      await ref.set(data)
    },
    async update(id, patch) {
      const ref = collection().doc(id)
      const existing = await ref.get()
      if (!existing.exists) {
        throw new CatalogConversionStorageError('Conversion rule not found.', 404)
      }
      await ref.update(patch)
    },
    async list(limit) {
      // Bounded collection read by document id only — no composite index required.
      const snap = await collection().limit(limit).get()
      return snap.docs.map((doc) => ({
        id: doc.id,
        data: (doc.data() ?? {}) as Record<string, unknown>,
      }))
    },
  }
}

export function createFirestoreCatalogConversionRuleStore(
  db: Firestore = getDb(),
  options: CatalogConversionRuleStoreOptions = {},
): CatalogConversionRuleStore {
  return createCatalogConversionRuleStore(
    createFirestoreCatalogConversionDocuments(db),
    options,
  )
}
