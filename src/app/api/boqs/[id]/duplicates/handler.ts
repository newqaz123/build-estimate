import type { DuplicateMatch } from '@/lib/boq-duplicates'

export interface DuplicatesDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  findDuplicates(id: string): Promise<DuplicateMatch[] | null>
}

/** Other quotes that are the same PDF file or look like the same quote (vendor, date, total, lines). */
export function createDuplicatesGetHandler(dependencies: DuplicatesDependencies) {
  return async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params
    try {
      const duplicates = await dependencies.findDuplicates(id)
      if (duplicates === null) return Response.json({ error: 'BOQ not found' }, { status: 404 })
      return Response.json({ duplicates })
    } catch (error) {
      console.error('Duplicate quote check failed:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
