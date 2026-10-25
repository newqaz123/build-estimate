import { createCatalogMergeUndoHandler } from '../handler'
import { catalogMergeDependencies } from '../dependencies'

export const POST = createCatalogMergeUndoHandler(catalogMergeDependencies)
