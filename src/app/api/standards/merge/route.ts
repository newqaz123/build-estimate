import { createCatalogMergePostHandler } from './handler'
import { catalogMergeDependencies } from './dependencies'

export const POST = createCatalogMergePostHandler(catalogMergeDependencies)
