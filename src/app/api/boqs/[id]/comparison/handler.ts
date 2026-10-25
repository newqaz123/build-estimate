import type { Boq } from '@/lib/boq-schema'
import { compareBoqToCatalog } from '@/lib/boq-catalog-comparison'
import type { StandardEntry } from '@/lib/standard-schema'
import type { HumanApprovedCatalogConversionRule } from '@/lib/catalog-conversion'

export interface ComparisonHandlerDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  loadBoqs: () => Promise<Boq[]>
  loadStandards: () => Promise<StandardEntry[]>
  loadUnitMap: () => Promise<Record<string, string>>
  loadConversionRules?: () => Promise<HumanApprovedCatalogConversionRule[]>
}

export function createComparisonGetHandler({
  authenticate,
  loadBoqs,
  loadStandards,
  loadUnitMap,
  loadConversionRules = async () => [],
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
      const [boqs, standards, unitMap, conversionRules] = await Promise.all([
        loadBoqs(),
        loadStandards(),
        loadUnitMap(),
        loadConversionRules(),
      ])
      const target = boqs.find((boq) => boq.id === id)

      if (!target) {
        return Response.json({ error: 'BOQ not found' }, { status: 404 })
      }

      return Response.json(
        compareBoqToCatalog(target, standards, boqs, unitMap, conversionRules),
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
