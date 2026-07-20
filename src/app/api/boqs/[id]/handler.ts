import { isSourceObjectNotFound } from '@/lib/boq-source-storage'
import { verifyBoqLocally } from '@/lib/boq-ingestion'
import type { Boq } from '@/lib/boq-schema'
import { toPublicBoq } from '@/lib/boq-public'
import { getBoqCatalogReadiness } from '@/lib/boq-catalog-readiness'
import { calculateBoqTotals } from '@/lib/boq-pricing'
import { BoqCanonicalValidationError, parseCanonicalBoqSections } from '@/lib/boq-canonical'

export type BoqDetailRouteContext = { params: Promise<{ id: string }> }
export type BoqUpdateDecision =
  | { kind: 'update'; updates: Record<string, unknown> }
  | { kind: 'rejected'; status: 400; body: Record<string, unknown> }
export type BoqUpdateResult = 'updated' | 'approved' | 'not-found' | Extract<BoqUpdateDecision, { kind: 'rejected' }>

interface BoqDetailDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  getBoq(id: string): Promise<Boq | null>
  updateBoq(id: string, prepareUpdate: (current: Boq) => BoqUpdateDecision): Promise<BoqUpdateResult>
  deleteBoq(id: string): Promise<void>
  loadSource(path: string): Promise<Buffer>
  deleteSource(path: string): Promise<void>
  saveSource(path: string, bytes: Uint8Array): Promise<void>
  logError(message: string, error: unknown): void
}

function computeTotals(sections: Boq['sections']) {
  return calculateBoqTotals(sections)
}

export function createBoqDetailHandlers(dependencies: BoqDetailDependencies) {
  async function GET(_request: Request, { params }: BoqDetailRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    try {
      const { id } = await params
      const boq = await dependencies.getBoq(id)
      if (!boq) return Response.json({ error: 'BOQ not found' }, { status: 404 })
      return Response.json(toPublicBoq(boq))
    } catch (error) {
      console.error('Error fetching BOQ:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  async function PUT(request: Request, { params }: BoqDetailRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    try {
      const { id } = await params
      const existing = await dependencies.getBoq(id)
      if (!existing) return Response.json({ error: 'BOQ not found' }, { status: 404 })

      const body = await request.json()
      const requestedUpdates: Record<string, unknown> = {}

      if (body.project !== undefined) requestedUpdates.project = body.project
      if (body.vendor !== undefined) requestedUpdates.vendor = body.vendor
      if (body.vendorId !== undefined) requestedUpdates.vendorId = body.vendorId
      if (body.workType !== undefined) {
        if (!['Structural', 'MEP', 'Finishing', 'Unclassified'].includes(body.workType)) {
          return Response.json(
            { error: 'workType must be Structural, MEP, Finishing, or Unclassified' },
            { status: 400 },
          )
        }
        requestedUpdates.workType = body.workType
      }
      if (body.date !== undefined) requestedUpdates.date = body.date
      if (body.status !== undefined) {
        const validStatuses = ['draft', 'parsed', 'active', 'review', 'approved', 'rejected']
        if (!validStatuses.includes(body.status)) {
          return Response.json({ error: 'Invalid status' }, { status: 400 })
        }
        requestedUpdates.status = body.status
      }
      const hasSections = body.sections !== undefined
      const requestSections = hasSections ? parseCanonicalBoqSections(body.sections) : undefined
      const updateResult = await dependencies.updateBoq(id, (current) => {
        const updates = { ...requestedUpdates }
        if (requestSections || body.status === 'approved') {
          const sections = requestSections ?? parseCanonicalBoqSections(current.sections)
          updates.sections = sections
          const { totalItems, grandTotal } = computeTotals(sections)
          updates.totalItems = totalItems
          updates.grandTotal = grandTotal
        }

        const candidate = { ...current, ...updates } as Boq
        const verification = verifyBoqLocally(candidate)
        if (candidate.status === 'approved' && verification.hasBlockingIssues) {
          return {
            kind: 'rejected',
            status: 400,
            body: { error: 'Resolve required BOQ fields before approval', verification },
          }
        }
        if (candidate.status === 'approved') {
          const catalogReadiness = getBoqCatalogReadiness(candidate)
          if (catalogReadiness.blocking > 0) {
            return {
              kind: 'rejected',
              status: 400,
              body: { error: 'Resolve catalog items before approval', catalogReadiness },
            }
          }
        }
        return { kind: 'update', updates }
      })
      if (typeof updateResult === 'object') {
        return Response.json(updateResult.body, { status: updateResult.status })
      }
      if (updateResult === 'approved') {
        return Response.json({ error: 'Approved BOQs are read-only' }, { status: 409 })
      }
      if (updateResult === 'not-found') {
        return Response.json({ error: 'BOQ not found' }, { status: 404 })
      }
      const updated = await dependencies.getBoq(id)
      return Response.json(updated ? toPublicBoq(updated) : null)
    } catch (error) {
      if (error instanceof BoqCanonicalValidationError || error instanceof RangeError) {
        return Response.json({ error: error.message }, { status: 400 })
      }
      console.error('Error updating BOQ:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  async function DELETE(_request: Request, { params }: BoqDetailRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    try {
      const { id } = await params
      const existing = await dependencies.getBoq(id)
      if (!existing) return Response.json({ error: 'BOQ not found' }, { status: 404 })

      let cachedSource: Buffer | null = null
      const sourcePath = existing.sourceStoragePath
      if (sourcePath) {
        try {
          cachedSource = await dependencies.loadSource(sourcePath)
        } catch (error) {
          if (!isSourceObjectNotFound(error)) {
            dependencies.logError('Error caching BOQ source before deletion:', error)
            return Response.json(
              { error: 'The BOQ source could not be deleted. The BOQ was not deleted.' },
              { status: 500 },
            )
          }
        }

        if (cachedSource) {
          try {
            await dependencies.deleteSource(sourcePath)
          } catch (error) {
            if (!isSourceObjectNotFound(error)) {
              dependencies.logError('Error deleting BOQ source:', error)
              return Response.json(
                { error: 'The BOQ source could not be deleted. The BOQ was not deleted.' },
                { status: 500 },
              )
            }
          }
        }
      }

      try {
        await dependencies.deleteBoq(id)
      } catch (error) {
        if (sourcePath && cachedSource) {
          try {
            await dependencies.saveSource(sourcePath, cachedSource)
          } catch (restoreError) {
            dependencies.logError('Error restoring BOQ source after Firestore deletion failure:', restoreError)
          }
        }
        dependencies.logError('Error deleting BOQ:', error)
        return Response.json({ error: 'Internal server error' }, { status: 500 })
      }

      return Response.json({ success: true })
    } catch (error) {
      dependencies.logError('Error deleting BOQ:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  return { GET, PUT, DELETE }
}
