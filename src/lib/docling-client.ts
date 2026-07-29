import { parseDoclingResult, type DoclingResult } from './boq-ingestion'

const DEFAULT_DOCLING_ORIGIN = 'http://localhost:5001'
const DOCLING_PARSE_TIMEOUT_MS = 180_000

export type DoclingClientErrorKind =
  | 'timeout'
  | 'cancelled'
  | 'unreachable'
  | 'rejected'
  | 'upstream'
  | 'invalid_response'

export class DoclingClientError extends Error {
  constructor(
    public readonly kind: DoclingClientErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'DoclingClientError'
  }
}

export function getAllowedDoclingOrigins(
  configuredOrigins = process.env.DOCLING_ALLOWED_ORIGINS,
): Set<string> {
  const allowed = new Set<string>([DEFAULT_DOCLING_ORIGIN])
  for (const candidate of configuredOrigins?.split(',') ?? []) {
    try {
      const url = new URL(candidate.trim())
      if (url.protocol === 'http:' || url.protocol === 'https:') allowed.add(url.origin)
    } catch {
      // Invalid configured origins are not added to the SSRF allowlist.
    }
  }
  return allowed
}

export function buildDoclingParseUrl(
  endpoint: string,
  allowedOrigins = getAllowedDoclingOrigins(),
): string {
  let url: URL
  try {
    url = new URL(endpoint.trim())
  } catch {
    throw new DoclingClientError('unreachable', 'Docling endpoint must be a valid HTTP or HTTPS URL')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || !allowedOrigins.has(url.origin)
  ) {
    throw new DoclingClientError('unreachable', 'Docling endpoint origin is not allowed')
  }

  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = basePath.endsWith('/parse')
    ? basePath
    : `${basePath}/parse`.replace(/^\/\//, '/')
  url.search = ''
  url.hash = ''
  return url.toString()
}

function safeDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const detail = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return detail ? detail.slice(0, 300) : null
}

async function documentRejectionMessage(response: Response): Promise<string | null> {
  if (response.status !== 400 && response.status !== 422) return null
  try {
    const body = await response.json() as { detail?: unknown; error?: unknown }
    const detail = safeDetail(body.detail) ?? safeDetail(body.error)
    if (!detail) return null
    if (/^Only PDF\b/i.test(detail)) return 'Only PDF files are supported'
    if (
      /^(?:PDF |File )?size\b/i.test(detail)
      || /^PDF (?:must be|is too|exceeds)\b.*(?:bytes?|MB)\b/i.test(detail)
    ) {
      return 'PDF must be between 1 byte and 20 MB'
    }
    if (/^No BOQ rows\b/i.test(detail)) return 'No BOQ line-item tables were found'
  } catch {
    // Non-JSON details are never reflected to callers.
  }
  return null
}

export type DoclingParseOptions = {
  pages: readonly number[]
}

function selectedPagesValue(options?: DoclingParseOptions): string | undefined {
  if (!options) return undefined
  if (
    options.pages.length === 0
    || options.pages.some((page) => !Number.isInteger(page) || page < 1)
  ) {
    throw new DoclingClientError('rejected', 'At least one valid PDF page must be selected')
  }
  return JSON.stringify([...new Set(options.pages)].sort((left, right) => left - right))
}

export async function parsePdfWithDocling(
  file: File,
  endpoint: string,
  signal?: AbortSignal,
  options?: DoclingParseOptions,
): Promise<DoclingResult> {
  const pages = selectedPagesValue(options)
  if (signal?.aborted) throw new DoclingClientError('cancelled', 'Request cancelled')

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), DOCLING_PARSE_TIMEOUT_MS)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  const body = new FormData()
  body.append('file', file, file.name)
  if (pages !== undefined) body.append('pages', pages)

  try {
    const response = await fetch(buildDoclingParseUrl(endpoint), {
      method: 'POST',
      body,
      signal: combinedSignal,
      cache: 'no-store',
      redirect: 'error',
    })
    if (response.status >= 400 && response.status < 500) {
      const message = await documentRejectionMessage(response)
      if (message) throw new DoclingClientError('rejected', message)
      console.error('Docling upstream request failed', { status: response.status })
      throw new DoclingClientError('upstream', 'Docling failed while processing the PDF')
    }
    if (!response.ok) {
      console.error('Docling upstream request failed', { status: response.status })
      throw new DoclingClientError('upstream', 'Docling failed while processing the PDF')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new DoclingClientError('invalid_response', 'Docling returned an invalid response')
    }
    try {
      return parseDoclingResult(payload)
    } catch {
      throw new DoclingClientError('invalid_response', 'Docling returned an invalid response')
    }
  } catch (error) {
    if (error instanceof DoclingClientError) throw error
    if (signal?.aborted) throw new DoclingClientError('cancelled', 'Request cancelled')
    if (timeoutController.signal.aborted) {
      throw new DoclingClientError('timeout', 'Docling parsing timed out')
    }
    throw new DoclingClientError('unreachable', 'Docling sidecar is not reachable')
  } finally {
    clearTimeout(timeout)
  }
}
