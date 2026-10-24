import type { Estimate } from '@/lib/estimate-schema'
import { parseEstimateStatus, prepareEstimateItems } from '@/lib/estimate-save'

export type EstimateRouteContext = { params: Promise<{ id: string }> }
type NewEstimate = Omit<Estimate, 'createdAt' | 'updatedAt'>

interface Authenticate {
  authenticate(): Promise<{ user?: unknown } | null>
  logError(message: string, error: unknown): void
}

export interface EstimateCreateDependencies extends Authenticate {
  newId(): string
  createEstimate(id: string, estimate: NewEstimate): Promise<Estimate | null>
}

export interface EstimateUpdateDependencies extends Authenticate {
  getEstimate(id: string): Promise<Estimate | null>
  updateEstimate(id: string, updates: Partial<Estimate>): Promise<Estimate | null>
}

const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 })
const badRequest = (error: string) => Response.json({ error }, { status: 400 })
const serverError = () => Response.json({ error: 'Internal server error' }, { status: 500 })

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json()
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}

const TEXT_FIELDS = [
  ['project', 'Project'],
  ['date', 'Date'],
  ['notes', 'Notes'],
] as const

export function createEstimateCreateHandler(dependencies: EstimateCreateDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return unauthorized()

    try {
      const body = await readBody(request)
      if (!body) return badRequest('Invalid estimate.')
      if (typeof body.name !== 'string' || !body.name) return badRequest('Name is required')
      for (const [field, label] of TEXT_FIELDS) {
        if (body[field] !== undefined && typeof body[field] !== 'string') return badRequest(`${label} must be text.`)
      }
      const prepared = prepareEstimateItems(body.items ?? [])
      if (!prepared.ok) return badRequest(prepared.error)

      const id = dependencies.newId()
      const created = await dependencies.createEstimate(id, {
        id,
        name: body.name,
        project: (body.project as string | undefined) || '',
        date: (body.date as string | undefined) || '',
        notes: (body.notes as string | undefined) || '',
        items: prepared.items,
        totalAmount: prepared.totalAmount,
        status: 'draft',
      })
      return Response.json(created, { status: 201 })
    } catch (error) {
      dependencies.logError('Error creating estimate:', error)
      return serverError()
    }
  }
}

export function createEstimateUpdateHandler(dependencies: EstimateUpdateDependencies) {
  return async function PUT(request: Request, { params }: EstimateRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return unauthorized()

    try {
      const { id } = await params
      const existing = await dependencies.getEstimate(id)
      if (!existing) return Response.json({ error: 'Estimate not found' }, { status: 404 })

      const body = await readBody(request)
      if (!body) return badRequest('Invalid estimate.')

      const updates: Partial<Estimate> = {}
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name) return badRequest('Name is required')
        updates.name = body.name
      }
      for (const [field, label] of TEXT_FIELDS) {
        if (body[field] === undefined) continue
        if (typeof body[field] !== 'string') return badRequest(`${label} must be text.`)
        updates[field] = body[field] as string
      }
      if (body.items !== undefined) {
        const prepared = prepareEstimateItems(body.items)
        if (!prepared.ok) return badRequest(prepared.error)
        updates.items = prepared.items
        updates.totalAmount = prepared.totalAmount
      }
      if (body.status !== undefined) {
        const status = parseEstimateStatus(body.status)
        if (!status) return badRequest('Status must be draft or final.')
        updates.status = status
      }

      return Response.json(await dependencies.updateEstimate(id, updates))
    } catch (error) {
      dependencies.logError('Error updating estimate:', error)
      return serverError()
    }
  }
}
