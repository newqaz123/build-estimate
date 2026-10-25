import { auth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import {
  mergeCatalogEntriesInFirestore,
  previewCatalogMergeInFirestore,
  undoCatalogMergeInFirestore,
} from '@/lib/catalog-merge-firestore'
import type { CatalogMergeDependencies } from './handler'

export const catalogMergeDependencies: CatalogMergeDependencies = {
  authenticate: auth,
  preview: (input) => previewCatalogMergeInFirestore(getDb(), input),
  merge: (input) => mergeCatalogEntriesInFirestore(getDb(), input),
  undo: (keepId) => undoCatalogMergeInFirestore(getDb(), keepId),
}
