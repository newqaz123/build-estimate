import { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { deleteSourcePdf, isSourceObjectNotFound } from '@/lib/boq-source-storage'
import { verifyBoqLocally } from '@/lib/boq-ingestion'
import { getDocument, updateDocument, deleteDocument } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'

type RouteContext = { params: Promise<{ id: string }> }

interface BoqDetailDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  getBoq(id: string): Promise<Boq | null>
  updateBoq(id: string, updates: Record<string, unknown>): Promise<void>
  deleteBoq(id: string): Promise<void>
  deleteSource(path: string): Promise<void>
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

function publicBoq(boq: Boq | null): Omit<Boq, 'sourceStoragePath'> | null {
  if (!boq) return null
  const safe: Partial<Boq> = { ...boq }
  delete safe.sourceStoragePath
  return safe as Omit<Boq, 'sourceStoragePath'>
}

export function createBoqDetailHandlers(dependencies: BoqDetailDependencies) {
  async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    try {
      const { id } = await params
      const boq = await dependencies.getBoq(id)
      if (!boq) return Response.json({ error: 'BOQ not found' }, { status: 404 })
      return Response.json(publicBoq(boq))
    } catch (error) {
      console.error('Error fetching BOQ:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  async function PUT(request: Request, { params }: RouteContext): Promise<Response> {
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
        if (!['Structural', 'MEP', 'Finishing'].includes(body.workType)) {
          return Response.json({ error: 'workType must be Structural, MEP, or Finishing' }, { status: 400 })
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
        return Response.json({ error: 'BOQ cannot be approved', verification }, { status: 400 })
      }

      await dependencies.updateBoq(id, updates)
      const updated = await dependencies.getBoq(id)
      return Response.json(publicBoq(updated))
    } catch (error) {
      console.error('Error updating BOQ:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  async function DELETE(_request: Request, { params }: RouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    try {
      const { id } = await params
      const existing = await dependencies.getBoq(id)
      if (!existing) return Response.json({ error: 'BOQ not found' }, { status: 404 })

      if (existing.sourceStoragePath) {
        try {
          await dependencies.deleteSource(existing.sourceStoragePath)
        } catch (error) {
          if (!isSourceObjectNotFound(error)) {
            console.error('Error deleting BOQ source:', error)
            return Response.json(
              { error: 'The BOQ source could not be deleted. The BOQ was not deleted.' },
              { status: 500 },
            )
          }
        }
      }

      await dependencies.deleteBoq(id)
      return Response.json({ success: true })
    } catch (error) {
      console.error('Error deleting BOQ:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  return { GET, PUT, DELETE }
}

const handlers = createBoqDetailHandlers({
  authenticate: auth,
  getBoq: (id) => getDocument<Boq>('boqs', id),
  updateBoq: (id, updates) => updateDocument('boqs', id, updates),
  deleteBoq: (id) => deleteDocument('boqs', id),
  deleteSource: deleteSourcePdf,
})

export async function GET(request: NextRequest, context: RouteContext) {
  return handlers.GET(request, context)
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return handlers.PUT(request, context)
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return handlers.DELETE(request, context)
}
