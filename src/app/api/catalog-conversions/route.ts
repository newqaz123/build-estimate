import { auth } from '@/lib/auth'
import type { HumanApprovedCatalogConversionRule } from '@/lib/catalog-conversion'
import {
  CatalogConversionStorageError,
  createFirestoreCatalogConversionRuleStore,
  parseCreateHumanCatalogConversionRuleInput,
  type CreateHumanCatalogConversionRuleInput,
} from '@/lib/catalog-conversion-storage'

type Authenticate = () => Promise<{ user?: { id?: string | null } | null } | null>

export interface CatalogConversionsPostDependencies {
  authenticate: Authenticate
  createRule: (
    input: CreateHumanCatalogConversionRuleInput,
    meta: { actorId: string },
  ) => Promise<HumanApprovedCatalogConversionRule>
}

export interface CatalogConversionsDeleteDependencies {
  authenticate: Authenticate
  archiveRule: (
    id: string,
    meta: { actorId: string },
  ) => Promise<HumanApprovedCatalogConversionRule>
}

export interface CatalogConversionsGetDependencies {
  authenticate: Authenticate
  listRules: (options?: { limit?: number }) => Promise<HumanApprovedCatalogConversionRule[]>
  getRule: (id: string) => Promise<HumanApprovedCatalogConversionRule | null>
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

async function authenticateOrError(
  authenticate: Authenticate,
): Promise<{ actorId: string } | Response> {
  let session: Awaited<ReturnType<Authenticate>>
  try {
    session = await authenticate()
  } catch (error) {
    console.error('Error authenticating catalog conversion request:', error)
    return jsonError('Internal server error', 500)
  }
  const actorId = session?.user?.id
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    return jsonError('Unauthorized', 401)
  }
  return { actorId: actorId.trim() }
}

async function readJsonBody(request: Request): Promise<unknown | Response> {
  try {
    return await request.json()
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonError('Request body must be valid JSON.', 400)
    }
    console.error('Error reading catalog conversion request:', error)
    return jsonError('Internal server error', 500)
  }
}

function isIdentityRuleId(id: string): boolean {
  return id.startsWith('identity:')
}

export function createCatalogConversionsPostHandler({
  authenticate,
  createRule,
}: CatalogConversionsPostDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const authResult = await authenticateOrError(authenticate)
    if (authResult instanceof Response) return authResult

    const body = await readJsonBody(request)
    if (body instanceof Response) return body

    let input: CreateHumanCatalogConversionRuleInput
    try {
      // Reject unknown keys / identity / AI-origin fields before persistence.
      input = parseCreateHumanCatalogConversionRuleInput(body)
    } catch (error) {
      if (error instanceof CatalogConversionStorageError) {
        return jsonError(error.message, error.status)
      }
      throw error
    }

    try {
      const rule = await createRule(input, { actorId: authResult.actorId })
      return Response.json(rule, { status: 201 })
    } catch (error) {
      if (error instanceof CatalogConversionStorageError) {
        return jsonError(error.message, error.status)
      }
      console.error('Error creating catalog conversion rule:', error)
      return jsonError('Internal server error', 500)
    }
  }
}

export function createCatalogConversionsDeleteHandler({
  authenticate,
  archiveRule,
}: CatalogConversionsDeleteDependencies) {
  return async function DELETE(request: Request): Promise<Response> {
    const authResult = await authenticateOrError(authenticate)
    if (authResult instanceof Response) return authResult

    const body = await readJsonBody(request)
    if (body instanceof Response) return body

    if (
      typeof body !== 'object'
      || body === null
      || Array.isArray(body)
      || Object.getPrototypeOf(body) !== Object.prototype
    ) {
      return jsonError('Invalid archive payload.', 400)
    }

    const record = body as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length !== 1 || keys[0] !== 'id') {
      return jsonError('Archive request must contain only id.', 400)
    }
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      return jsonError('Invalid id.', 400)
    }
    const id = record.id.trim()
    if (isIdentityRuleId(id)) {
      return jsonError('Identity conversion rules cannot be archived.', 400)
    }

    try {
      const rule = await archiveRule(id, { actorId: authResult.actorId })
      return Response.json(rule)
    } catch (error) {
      if (error instanceof CatalogConversionStorageError) {
        return jsonError(error.message, error.status)
      }
      console.error('Error archiving catalog conversion rule:', error)
      return jsonError('Internal server error', 500)
    }
  }
}

export function createCatalogConversionsGetHandler({
  authenticate,
  listRules,
  getRule,
}: CatalogConversionsGetDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const authResult = await authenticateOrError(authenticate)
    if (authResult instanceof Response) return authResult

    try {
      const url = new URL(request.url)
      const id = url.searchParams.get('id')
      if (id !== null) {
        const trimmed = id.trim()
        if (trimmed === '') {
          return jsonError('Invalid id.', 400)
        }
        if (isIdentityRuleId(trimmed)) {
          return jsonError('Identity conversion rules are not stored as documents.', 400)
        }
        const rule = await getRule(trimmed)
        if (!rule) {
          return jsonError('Conversion rule not found.', 404)
        }
        return Response.json({ rule })
      }

      const limitParam = url.searchParams.get('limit')
      const limit = limitParam === null ? undefined : Number(limitParam)
      if (limitParam !== null && (!Number.isInteger(limit) || Number.isNaN(limit))) {
        return jsonError('Invalid limit.', 400)
      }
      const rules = await listRules(limit === undefined ? undefined : { limit })
      return Response.json({ rules })
    } catch (error) {
      if (error instanceof CatalogConversionStorageError) {
        return jsonError(error.message, error.status)
      }
      console.error('Error reading catalog conversion rules:', error)
      return jsonError('Internal server error', 500)
    }
  }
}

function productionStore() {
  return createFirestoreCatalogConversionRuleStore()
}

export const POST = createCatalogConversionsPostHandler({
  authenticate: auth,
  createRule: async (input, meta) => productionStore().create(input, meta),
})

export const DELETE = createCatalogConversionsDeleteHandler({
  authenticate: auth,
  archiveRule: async (id, meta) => productionStore().archive(id, meta),
})

export const GET = createCatalogConversionsGetHandler({
  authenticate: auth,
  listRules: async (options) => productionStore().list(options),
  getRule: async (id) => productionStore().get(id),
})
