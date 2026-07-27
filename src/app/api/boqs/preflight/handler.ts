import type { PreflightStore } from '@/lib/boq-preflight-storage'
import type { AnalysisAdapter, StorageAdapter } from '@/lib/boq-preflight-service'
import { createPreflightService } from '@/lib/boq-preflight-service'

interface PreflightRouteDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  createStore: () => PreflightStore
  analysisAdapter: AnalysisAdapter
  storageAdapter: StorageAdapter
  now: () => Date
}

export function createPreflightRouteHandlers(dependencies: PreflightRouteDependencies) {
  const service = createPreflightService({
    store: dependencies.createStore(),
    analysisAdapter: dependencies.analysisAdapter,
    storageAdapter: dependencies.storageAdapter,
    now: dependencies.now,
  })

  return {
    async POST(request: Request): Promise<Response> {
      const session = await dependencies.authenticate()
      if (!session?.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const userId = (session.user as { id: string }).id

      let file: File
      try {
        const formData = await request.formData()
        file = formData.get('file') as File
        if (!file) {
          return Response.json({ error: 'Upload one PDF between 1 byte and 20 MB.' }, { status: 400 })
        }
      } catch {
        return Response.json({ error: 'Invalid multipart form data' }, { status: 400 })
      }

      try {
        const result = await service.createPreflight(file, userId)
        return Response.json(result, { status: 201 })
      } catch (error) {
        if (error instanceof TypeError) {
          return Response.json({ error: error.message }, { status: 400 })
        }
        console.error('Preflight creation failed:', error)
        return Response.json({ error: 'The preflight upload could not be created. Try again.' }, { status: 500 })
      }
    },
  }
}

export function createPreflightDetailHandlers(dependencies: PreflightRouteDependencies) {
  const service = createPreflightService({
    store: dependencies.createStore(),
    analysisAdapter: dependencies.analysisAdapter,
    storageAdapter: dependencies.storageAdapter,
    now: dependencies.now,
  })

  return {
    async GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
      const session = await dependencies.authenticate()
      if (!session?.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { id } = await context.params
      const userId = (session.user as { id: string }).id

      const record = await dependencies.createStore().getOwned(id, userId)
      if (!record) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      const safe = {
        id: record.id,
        fileName: record.fileName,
        pageCount: record.pageCount,
        status: record.status,
        pages: record.pages,
        confirmedPages: record.confirmedPages,
      }

      return Response.json(safe)
    },

    async PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
      const session = await dependencies.authenticate()
      if (!session?.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { id } = await context.params
      const userId = (session.user as { id: string }).id

      let selection: { pages: number[] }
      try {
        selection = await request.json()
      } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 })
      }

      try {
        const result = await service.consumePreflight(id, userId, selection)
        return Response.json(result, { status: 200 })
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return Response.json({ error: 'Not found' }, { status: 404 })
          }
          if (error.message.includes('at least one page')) {
            return Response.json({ error: error.message }, { status: 400 })
          }
        }
        console.error('Preflight consumption failed:', error)
        return Response.json({ error: 'The preflight upload could not be consumed. Try again.' }, { status: 500 })
      }
    },

    async DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
      const session = await dependencies.authenticate()
      if (!session?.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { id } = await context.params
      const userId = (session.user as { id: string }).id

      try {
        await service.cancelPreflight(id, userId)
        return new Response(null, { status: 204 })
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
        console.error('Preflight cancellation failed:', error)
        return Response.json({ error: 'The preflight upload could not be cancelled. Try again.' }, { status: 500 })
      }
    },

    async getPage(request: Request, context: { params: Promise<{ id: string; page: string }> }): Promise<Response> {
      const session = await dependencies.authenticate()
      if (!session?.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { id, page } = await context.params
      const userId = (session.user as { id: string }).id
      const pageNumber = parseInt(page, 10)

      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return Response.json({ error: 'Invalid page number' }, { status: 400 })
      }

      const store = dependencies.createStore()
      const record = await store.getOwned(id, userId)
      if (!record) {
        return Response.json({ error: 'Not found' }, { status: 404 })
      }

      if (pageNumber > record.pageCount) {
        return Response.json({ error: 'Page number out of range' }, { status: 400 })
      }

      try {
        const file = await dependencies.storageAdapter.loadSourcePdf(record.sourceDigest)
        const preview = await dependencies.analysisAdapter.renderPreview(file, pageNumber)

        return new Response(preview as unknown as BodyInit, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        })
      } catch (error) {
        console.error('Preview generation failed:', error)
        return Response.json({ error: 'Preview generation failed' }, { status: 500 })
      }
    },
  }
}
