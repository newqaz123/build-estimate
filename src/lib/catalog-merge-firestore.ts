import type { Firestore, Transaction } from 'firebase-admin/firestore'
import type { Boq } from './boq-schema'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import { CATALOG_CONVERSION_RULES_COLLECTION } from './catalog-conversion-storage'
import { CATALOG_MAPPING_CACHE_COLLECTION } from './catalog-mapping-cache-storage'
import {
  planCatalogMerge,
  planCatalogMergeUndo,
  previewCatalogMerge,
  type CatalogMergeInput,
  type CatalogMappingRef,
  type CatalogMergePreview,
  type MergeAwareStandard,
} from './catalog-merge'
import type { Estimate } from './estimate-schema'

export interface CatalogMergeResult {
  keptId: string
  archivedIds: string[]
  quoteRows: number
  estimateRows: number
  conversions: number
  mappings: number
}

/** Firestore rejects undefined; drop it (and the id, which is the doc key). */
function toDoc<T extends { id: string }>(value: T): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  delete doc.id
  return doc
}

async function readAll(transaction: Transaction | null, db: Firestore) {
  const get = async (name: string) => {
    const query = db.collection(name)
    const snap = transaction ? await transaction.get(query) : await query.get()
    return snap.docs.map((doc) => ({ ...doc.data(), id: doc.id }))
  }
  const [standards, boqs, estimates, rules, mappingDocs] = await Promise.all([
    get('standards'), get('boqs'), get('estimates'), get(CATALOG_CONVERSION_RULES_COLLECTION), get(CATALOG_MAPPING_CACHE_COLLECTION),
  ])
  const mappings: CatalogMappingRef[] = mappingDocs
    .filter((doc): doc is typeof doc & { catalogId: string } => typeof (doc as { catalogId?: unknown }).catalogId === 'string')
    .map((doc) => ({ id: doc.id, catalogId: doc.catalogId }))
  const settingsRef = db.collection('settings').doc('workspace')
  const settings = transaction ? await transaction.get(settingsRef) : await settingsRef.get()
  const unitMap = ((settings.data() as { fuzzy?: { unitMap?: Record<string, string> } } | undefined)?.fuzzy?.unitMap) ?? {}
  return {
    standards: standards as MergeAwareStandard[],
    boqs: boqs as Boq[],
    estimates: estimates as Estimate[],
    rules: rules as HumanApprovedCatalogConversionRule[],
    mappings,
    unitMap,
  }
}

export async function previewCatalogMergeInFirestore(db: Firestore, input: CatalogMergeInput): Promise<CatalogMergePreview> {
  const data = await readAll(null, db)
  return previewCatalogMerge({ ...data, input })
}

export async function mergeCatalogEntriesInFirestore(db: Firestore, input: CatalogMergeInput, now = new Date().toISOString()): Promise<CatalogMergeResult> {
  return db.runTransaction(async (transaction) => {
    const data = await readAll(transaction, db)
    const plan = planCatalogMerge({ ...data, input, now })
    transaction.set(db.collection('standards').doc(plan.kept.id), toDoc(plan.kept))
    for (const entry of plan.archived) transaction.set(db.collection('standards').doc(entry.id), toDoc(entry))
    for (const boq of plan.boqs) transaction.update(db.collection('boqs').doc(boq.id), { sections: JSON.parse(JSON.stringify(boq.sections)), updatedAt: now })
    for (const estimate of plan.estimates) transaction.update(db.collection('estimates').doc(estimate.id), { items: JSON.parse(JSON.stringify(estimate.items)), updatedAt: now })
    for (const rule of plan.rules) transaction.update(db.collection(CATALOG_CONVERSION_RULES_COLLECTION).doc(rule.id), { catalogId: rule.catalogId, version: rule.version })
    for (const mapping of plan.mappings) transaction.update(db.collection(CATALOG_MAPPING_CACHE_COLLECTION).doc(mapping.id), { catalogId: mapping.catalogId })
    return {
      keptId: plan.kept.id,
      archivedIds: plan.archived.map((entry) => entry.id),
      quoteRows: plan.undo.rows.length,
      estimateRows: plan.undo.estimateRows.length,
      conversions: plan.rules.length,
      mappings: plan.mappings.length,
    }
  })
}

export async function undoCatalogMergeInFirestore(db: Firestore, keepId: string, now = new Date().toISOString()): Promise<{ keptId: string; restoredIds: string[] }> {
  return db.runTransaction(async (transaction) => {
    const data = await readAll(transaction, db)
    const plan = planCatalogMergeUndo({ ...data, keepId, now })
    transaction.set(db.collection('standards').doc(plan.kept.id), toDoc(plan.kept))
    for (const entry of plan.restored) transaction.set(db.collection('standards').doc(entry.id), toDoc(entry))
    for (const boq of plan.boqs) transaction.update(db.collection('boqs').doc(boq.id), { sections: JSON.parse(JSON.stringify(boq.sections)), updatedAt: now })
    for (const estimate of plan.estimates) transaction.update(db.collection('estimates').doc(estimate.id), { items: JSON.parse(JSON.stringify(estimate.items)), updatedAt: now })
    for (const rule of plan.rules) transaction.update(db.collection(CATALOG_CONVERSION_RULES_COLLECTION).doc(rule.id), { catalogId: rule.catalogId, version: rule.version })
    for (const mapping of plan.mappings) transaction.update(db.collection(CATALOG_MAPPING_CACHE_COLLECTION).doc(mapping.id), { catalogId: mapping.catalogId })
    return { keptId: plan.kept.id, restoredIds: plan.restored.map((entry) => entry.id) }
  })
}
