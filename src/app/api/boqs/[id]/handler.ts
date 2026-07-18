import { isSourceObjectNotFound } from '@/lib/boq-source-storage'
import { verifyBoqLocally } from '@/lib/boq-ingestion'
import type { Boq } from '@/lib/boq-schema'
import { toPublicBoq } from '@/lib/boq-public'
import { getBoqCatalogReadiness } from '@/lib/boq-catalog-readiness'

export type BoqDetailRouteContext = { params: Promise<{ id: string }> }

interface BoqDetailDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  getBoq(id: string): Promise<Boq | null>
  updateBoq(id: string, updates: Record<string, unknown>): Promise<void>
  deleteBoq(id: string): Promise<void>
  loadSource(path: string): Promise<Buffer>
  deleteSource(path: string): Promise<void>
  saveSource(path: string, bytes: Uint8Array): Promise<void>
  logError(message: string, error: unknown): void
}

function computeTotals(sections: unknown) {
  if (!Array.isArray(sections)) return { totalItems: 0, grandTotal: Number.NaN }

  let totalItems = 0
  let grandTotal = 0
  for (const section of sections) {
    const items = typeof section === 'object' && section !== null && Array.isArray((section as { items?: unknown }).items)
      ? (section as { items: unknown[] }).items
      : []
    totalItems += items.length
    for (const row of items) {
      const total = typeof row === 'object' && row !== null ? (row as { total?: unknown }).total : undefined
      grandTotal += typeof total === 'number' ? total : Number.NaN
    }
  }
  return { totalItems, grandTotal }
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
      const updates: Record<string, unknown> = {}

      if (body.project !== undefined) updates.project = body.project
      if (body.vendor !== undefined) updates.vendor = body.vendor
      if (body.vendorId !== undefined) updates.vendorId = body.vendorId
      if (body.workType !== undefined) {
        if (!['Structural', 'MEP', 'Finishing', 'Unclassified'].includes(body.workType)) {
          return Response.json(
            { error: 'workType must be Structural, MEP, Finishing, or Unclassified' },
            { status: 400 },
          )
        }
        updates.workType = body.workType
      }
      if (body.date !== undefined) updates.date = body.date
      if (body.status !== undefined) {
        const validStatuses = ['draft', 'parsed', 'active', 'review', 'approved', 'rejected']
        if (!validStatuses.includes(body.status)) {
          return Response.json({ error: 'Invalid status' }, { status: 400 })
        }
        updates.status = body.status
      }
      if (body.sections !== undefined) {
        updates.sections = body.sections
        const { totalItems, grandTotal } = computeTotals(body.sections)
        updates.totalItems = totalItems
        updates.grandTotal = grandTotal
      }

      const candidate = { ...existing, ...updates } as Boq
      const verification = verifyBoqLocally(candidate)
      if (candidate.status === 'approved' && verification.hasBlockingIssues) {
        return Response.json(
          { error: 'Resolve required BOQ fields before approval', verification },
          { status: 400 },
        )
      }
      if (candidate.status === 'approved') {
        const catalogReadiness = getBoqCatalogReadiness(candidate)
        if (catalogReadiness.blocking > 0) {
          return Response.json(
            { error: 'Resolve catalog items before approval', catalogReadiness },
            { status: 400 },
          )
        }
      }

      await dependencies.updateBoq(id, updates)
      const updated = await dependencies.getBoq(id)
      return Response.json(updated ? toPublicBoq(updated) : null)
    } catch (error) {
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
