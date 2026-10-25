import { CatalogMergeError, parseCatalogMergeInput, type CatalogMergeInput, type CatalogMergePreview } from '@/lib/catalog-merge'
import type { CatalogMergeResult } from '@/lib/catalog-merge-firestore'

export interface CatalogMergeDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  preview(input: CatalogMergeInput): Promise<CatalogMergePreview>
  merge(input: CatalogMergeInput): Promise<CatalogMergeResult>
  undo(keepId: string): Promise<{ keptId: string; restoredIds: string[] }>
}

function failure(error: unknown, label: string): Response {
  if (error instanceof CatalogMergeError) return Response.json({ error: error.message }, { status: error.status })
  console.error(label, error)
  return Response.json({ error: 'Internal server error' }, { status: 500 })
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new CatalogMergeError('Request body must be valid JSON.')
  }
}

/** POST /api/standards/merge — `?preview=1` returns the combined price history without writing. */
export function createCatalogMergePostHandler(dependencies: CatalogMergeDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    try {
      const input = parseCatalogMergeInput(await readBody(request))
      if (new URL(request.url).searchParams.get('preview') === '1') {
        return Response.json({ preview: await dependencies.preview(input) })
      }
      return Response.json(await dependencies.merge(input))
    } catch (error) {
      return failure(error, 'Catalog merge failed:')
    }
  }
}

/** POST /api/standards/merge/undo — undo the last merge into `keepId`. */
export function createCatalogMergeUndoHandler(dependencies: CatalogMergeDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    try {
      const body = await readBody(request) as { keepId?: unknown }
      const keepId = typeof body?.keepId === 'string' ? body.keepId.trim() : ''
      if (!keepId) throw new CatalogMergeError('keepId is required.')
      return Response.json(await dependencies.undo(keepId))
    } catch (error) {
      return failure(error, 'Undo catalog merge failed:')
    }
  }
}
