import { createHash } from 'node:crypto'
import { stableCanonicalJson } from './boq-extraction-run'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import { canonicalUnit, normalizeCatalogText } from './standard-matching'

/** Bump when the hashed cache-key payload shape changes. */
export const CATALOG_MAPPING_CACHE_KEY_VERSION = 1 as const

export interface ApprovedCatalogMapping {
  sourceSignature: string
  catalogId: string
  conversionRuleId?: string
  approvedBy: string
  approvedAt: string
}

export type CatalogMappingOrigin = 'human' | 'model'

export interface CatalogMappingRecord extends ApprovedCatalogMapping {
  origin: CatalogMappingOrigin
}

/**
 * Exact public cache contract.
 * `put` always means explicit human approval — no origin option footgun.
 */
export interface CatalogMappingCache {
  get(key: string): Promise<ApprovedCatalogMapping | null>
  put(key: string, mapping: ApprovedCatalogMapping): Promise<void>
  remove(key: string): Promise<void>
}

export interface CatalogFingerprintEntry {
  id: string
  description: string
  unit: string
  aliases?: readonly string[]
  archivedAt?: string
  updatedAt?: string
}

export type ConversionFingerprintEntry = Pick<
  HumanApprovedCatalogConversionRule,
  | 'id'
  | 'sourceUnit'
  | 'catalogUnit'
  | 'catalogUnitsPerSourceUnit'
  | 'scope'
  | 'version'
> & {
  catalogId?: string
  archivedAt?: string
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableCanonicalJson(value)).digest('hex')}`
}

export function isHashedCatalogMappingCacheKey(key: string): boolean {
  return typeof key === 'string' && /^sha256:[a-f0-9]{64}$/.test(key)
}

/**
 * Mapping/shortlist/AI revalidation signature.
 * Description + unit only — never workspaceScope or unitMap.
 */
export function buildSourceSignature(input: {
  description: string
  unit: string
}): string {
  return digest({
    description: normalizeCatalogText(input.description),
    unit: canonicalUnit(input.unit, {}),
  })
}

/**
 * Scope-sensitive signature used only inside Task 6 hashed cache keys.
 * Incorporates workspaceScope + unitMap so keys isolate workspace context
 * without poisoning mapping.sourceSignature revalidation.
 */
export function buildScopedSourceSignature(input: {
  description: string
  unit: string
  unitMap?: Record<string, string>
  workspaceScope?: string
}): string {
  return digest({
    description: normalizeCatalogText(input.description),
    unit: canonicalUnit(input.unit, input.unitMap ?? {}),
    workspaceScope: input.workspaceScope?.trim() ?? '',
  })
}

export function buildCatalogFingerprint(
  catalog: readonly CatalogFingerprintEntry[],
): string {
  const entries = catalog
    .map((entry) => ({
      id: entry.id,
      description: entry.description,
      unit: entry.unit,
      aliases: [...(entry.aliases ?? [])].map((alias) => alias).sort((left, right) => left.localeCompare(right)),
      archivedAt: entry.archivedAt ?? null,
      updatedAt: entry.updatedAt ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return digest(entries)
}

export function buildConversionFingerprint(
  rules: readonly ConversionFingerprintEntry[],
): string {
  const entries = rules
    .map((rule) => ({
      id: rule.id,
      sourceUnit: rule.sourceUnit,
      catalogUnit: rule.catalogUnit,
      catalogUnitsPerSourceUnit: rule.catalogUnitsPerSourceUnit,
      scope: rule.scope,
      catalogId: rule.catalogId ?? null,
      version: rule.version,
      archivedAt: rule.archivedAt ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return digest(entries)
}

export function buildCatalogMappingCacheKey(input: {
  sourceSignature: string
  workspaceScope?: string
  catalogFingerprint: string
  conversionFingerprint: string
  promptVersion: string
  modelVersion?: string
}): string {
  return digest({
    v: CATALOG_MAPPING_CACHE_KEY_VERSION,
    sourceSignature: input.sourceSignature,
    workspaceScope: input.workspaceScope?.trim() ?? '',
    catalogFingerprint: input.catalogFingerprint,
    conversionFingerprint: input.conversionFingerprint,
    promptVersion: input.promptVersion,
    modelVersion: input.modelVersion ?? '',
  })
}

export function toApprovedCatalogMapping(
  record: CatalogMappingRecord | ApprovedCatalogMapping,
): ApprovedCatalogMapping {
  const mapping: ApprovedCatalogMapping = {
    sourceSignature: record.sourceSignature,
    catalogId: record.catalogId,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
  }
  if (record.conversionRuleId !== undefined) {
    mapping.conversionRuleId = record.conversionRuleId
  }
  return mapping
}

/**
 * Human-approved mappings always outrank model-only advice.
 * Returns the public ApprovedCatalogMapping shape (no origin field).
 */
export function selectPreferredCatalogMapping(
  human: CatalogMappingRecord | ApprovedCatalogMapping | null | undefined,
  model: CatalogMappingRecord | ApprovedCatalogMapping | null | undefined,
): ApprovedCatalogMapping | null {
  if (human) return toApprovedCatalogMapping(human)
  if (model) return toApprovedCatalogMapping(model)
  return null
}
