import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { toPublicBoq } from '@/lib/boq-public'
import { BoqCanonicalValidationError, parseCanonicalBoqSections } from '@/lib/boq-canonical'
import { ApprovalError, planApproval, planReopen, type ApprovalChoice, type ApprovalPlan } from '@/lib/boq-approval'

export type BoqRouteContext = { params: Promise<{ id: string }> }

export interface ApprovalStoreState {
  boq: Boq
  standards: StandardEntry[]
  unitMap: Record<string, string>
}

export interface ApprovalDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  /**
   * Read the quote, the catalog and the unit map, let `plan` decide, then write
   * the quote plus the changed catalog items atomically. Returns null when the
   * quote does not exist.
   */
  transact<T extends { boq: Boq; standards: StandardEntry[] }>(
    id: string,
    plan: (state: ApprovalStoreState) => T | { rejected: Response },
  ): Promise<T | { rejected: Response } | null>
  now(): string
}

const WORK_TYPES = ['Structural', 'MEP', 'Finishing', 'Unclassified']
const CONFIDENCES = new Set(['exact', 'fuzzy', 'llm', 'manual'])

function parseChoices(value: unknown): ApprovalChoice[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 5000) throw new ApprovalError('choices must be an array.')
  return value.map((raw) => {
    if (typeof raw !== 'object' || raw === null) throw new ApprovalError('Each choice must be an object.')
    const entry = raw as Record<string, unknown>
    const sectionIndex = entry.sectionIndex
    const itemIndex = entry.itemIndex
    if (!Number.isInteger(sectionIndex) || (sectionIndex as number) < 0 || !Number.isInteger(itemIndex) || (itemIndex as number) < 0) {
      throw new ApprovalError('Each choice needs sectionIndex and itemIndex.')
    }
    if (entry.standardId !== null && (typeof entry.standardId !== 'string' || entry.standardId.trim() === '' || entry.standardId.length > 200)) {
      throw new ApprovalError('standardId must be a catalog id or null.')
    }
    if (entry.confidence !== undefined && !CONFIDENCES.has(String(entry.confidence))) throw new ApprovalError('Invalid confidence.')
    for (const key of ['itemId', 'itemCode'] as const) {
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || (entry[key] as string).length > 200)) throw new ApprovalError(`${key} must be a string.`)
    }
    return {
      sectionIndex: sectionIndex as number,
      itemIndex: itemIndex as number,
      ...(typeof entry.itemId === 'string' ? { itemId: entry.itemId } : {}),
      ...(typeof entry.itemCode === 'string' ? { itemCode: entry.itemCode } : {}),
      standardId: entry.standardId === null ? null : (entry.standardId as string).trim(),
      ...(entry.confidence !== undefined ? { confidence: entry.confidence as ApprovalChoice['confidence'] & string } : {}),
    }
  })
}

function parseEdits(body: Record<string, unknown>): Partial<Boq> {
  const edits: Partial<Boq> = {}
  for (const key of ['project', 'vendor', 'date'] as const) {
    if (body[key] === undefined) continue
    if (typeof body[key] !== 'string' || (body[key] as string).length > 500) throw new ApprovalError(`${key} must be text.`)
    edits[key] = (body[key] as string).trim()
  }
  if (body.vendorId !== undefined) {
    if (typeof body.vendorId !== 'string') throw new ApprovalError('vendorId must be text.')
    edits.vendorId = body.vendorId
  }
  if (body.workType !== undefined) {
    if (!WORK_TYPES.includes(String(body.workType))) throw new ApprovalError('workType must be Structural, MEP, Finishing, or Unclassified.')
    edits.workType = body.workType as Boq['workType']
  }
  if (body.sections !== undefined) edits.sections = parseCanonicalBoqSections(body.sections)
  return edits
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApprovalError) return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof BoqCanonicalValidationError || error instanceof RangeError) return Response.json({ error: error.message }, { status: 400 })
  console.error('Error approving BOQ:', error)
  return Response.json({ error: 'Internal server error' }, { status: 500 })
}

export function createApprovalHandlers(dependencies: ApprovalDependencies) {
  async function approve(request: Request, { params }: BoqRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    try {
      const { id } = await params
      let body: unknown
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
      const choices = parseChoices(record.choices)
      const edits = parseEdits(record)
      const now = dependencies.now()
      const result = await dependencies.transact<ApprovalPlan>(id, (state) => {
        const plan = planApproval({ boq: { ...state.boq, ...edits }, standards: state.standards, choices, now, unitMap: state.unitMap })
        if (plan.blocking.length > 0) {
          return { rejected: Response.json({ error: 'Fix these before approving', blocking: plan.blocking, notes: plan.notes }, { status: 400 }) }
        }
        return plan
      })
      if (result === null) return Response.json({ error: 'BOQ not found' }, { status: 404 })
      if ('rejected' in result) return result.rejected
      return Response.json({ boq: toPublicBoq(result.boq), linked: result.linked, noCatalog: result.noCatalog, notes: result.notes })
    } catch (error) {
      return errorResponse(error)
    }
  }

  async function reopen(_request: Request, { params }: BoqRouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    try {
      const { id } = await params
      const now = dependencies.now()
      const result = await dependencies.transact(id, (state) => planReopen({ boq: state.boq, standards: state.standards, now }))
      if (result === null) return Response.json({ error: 'BOQ not found' }, { status: 404 })
      if ('rejected' in result) return result.rejected
      return Response.json({ boq: toPublicBoq(result.boq) })
    } catch (error) {
      return errorResponse(error)
    }
  }

  return { approve, reopen }
}
