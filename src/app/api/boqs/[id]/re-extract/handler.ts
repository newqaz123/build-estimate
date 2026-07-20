import type { Boq } from '@/lib/boq-schema'
import { ReextractError, reextractBoqSource, type ReextractDependencies } from '@/lib/boq-reextract'

export type ReextractRouteContext = { params: Promise<{ id: string }> }
export interface ReextractHandlerDependencies extends ReextractDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
}

export function createReextractHandler(dependencies: ReextractHandlerDependencies) {
  return async function POST(_request: Request, { params }: ReextractRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    if (!id || id.includes('/')) return Response.json({ error: 'Invalid BOQ id' }, { status: 400 })
    try {
      const result = await reextractBoqSource(id, dependencies)
      return Response.json({ boq: result.canonicalBoq as Boq, extractionRun: result.run }, { status: 201 })
    } catch (error) {
      if (error instanceof ReextractError) {
        const status = error.code === 'boq_not_found' ? 404 : error.code === 'source_unavailable' || error.code === 'v3_required' ? 400 : 500
        return Response.json({ error: error.message }, { status })
      }
      console.error('BOQ re-extraction failed')
      return Response.json({ error: 'BOQ re-extraction failed' }, { status: 500 })
    }
  }
}
