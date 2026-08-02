import type { Boq } from '@/lib/boq-schema'
import { compareBoqToCatalog } from '@/lib/boq-catalog-comparison'
import type { StandardEntry } from '@/lib/standard-schema'

export interface ComparisonHandlerDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  loadBoqs: () => Promise<Boq[]>
  loadStandards: () => Promise<StandardEntry[]>
  loadUnitMap: () => Promise<Record<string, string>>
}

export function createComparisonGetHandler({
  authenticate,
  loadBoqs,
  loadStandards,
  loadUnitMap,
}: ComparisonHandlerDependencies) {
  return async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    try {
      const session = await authenticate()
      if (!session?.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { id } = await params
      const [boqs, standards, unitMap] = await Promise.all([
        loadBoqs(),
        loadStandards(),
        loadUnitMap(),
      ])
      const target = boqs.find((boq) => boq.id === id)

      if (!target) {
        return Response.json({ error: 'BOQ not found' }, { status: 404 })
      }

      return Response.json(
        compareBoqToCatalog(target, standards, boqs, unitMap),
      )
    } catch (error) {
      console.error('Error comparing BOQ to catalog:', error)
      return Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      )
    }
  }
}
