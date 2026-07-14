import { parseDoclingResult, type DoclingResultV2 } from './boq-ingestion'

const DOCLING_PARSE_TIMEOUT_MS = 180_000

export type DoclingClientErrorKind = 'timeout' | 'unreachable' | 'rejected' | 'invalid_response'

export class DoclingClientError extends Error {
  constructor(
    public readonly kind: DoclingClientErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'DoclingClientError'
  }
}

export function buildDoclingParseUrl(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new DoclingClientError('unreachable', 'Docling endpoint must be a valid HTTP or HTTPS URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DoclingClientError('unreachable', 'Docling endpoint must use HTTP or HTTPS')
  }

  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = basePath.endsWith('/parse')
    ? basePath
    : `${basePath}/parse`.replace(/^\/\//, '/')
  url.search = ''
  url.hash = ''
  return url.toString()
}

function safeUpstreamDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const detail = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return detail ? detail.slice(0, 300) : null
}

async function rejectedMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: unknown; error?: unknown }
    const detail = safeUpstreamDetail(body.detail) ?? safeUpstreamDetail(body.error)
    if (detail) return `Docling rejected the PDF: ${detail}`
  } catch {
    // Non-JSON error responses are deliberately not reflected to the caller.
  }
  return `Docling rejected the PDF (status ${response.status})`
}

export async function parsePdfWithDocling(
  file: File,
  endpoint: string,
  signal?: AbortSignal,
): Promise<DoclingResultV2> {
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), DOCLING_PARSE_TIMEOUT_MS)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal
  const body = new FormData()
  body.append('file', file, file.name)

  try {
    const response = await fetch(buildDoclingParseUrl(endpoint), {
      method: 'POST',
      body,
      signal: combinedSignal,
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new DoclingClientError('rejected', await rejectedMessage(response))
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
    if (combinedSignal.aborted) {
      throw new DoclingClientError('timeout', 'Docling parsing timed out')
    }
    throw new DoclingClientError('unreachable', 'Docling sidecar is not reachable')
  } finally {
    clearTimeout(timeout)
  }
}
