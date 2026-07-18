import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

const DOCLING_HEALTH_TIMEOUT_MS = 8_000

export function buildDoclingHealthUrl(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Docling endpoint must use HTTP or HTTPS')
  }

  const basePath = url.pathname.replace(/\/+$/, '')
  if (!basePath.endsWith('/health')) {
    url.pathname = `${basePath}/health`.replace(/^\/\//, '/')
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let endpoint: string
  try {
    const body = await request.json() as { endpoint?: unknown }
    if (typeof body.endpoint !== 'string' || !body.endpoint.trim()) {
      return NextResponse.json({ error: 'Docling endpoint is required' }, { status: 400 })
    }
    endpoint = buildDoclingHealthUrl(body.endpoint.trim())
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid Docling endpoint'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOCLING_HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) {
      return NextResponse.json({ error: `Docling health check returned ${response.status}` }, { status: 502 })
    }

    const data = await response.json() as { status?: unknown }
    if (data.status !== 'ok') {
      return NextResponse.json({ error: 'Docling health response was invalid' }, { status: 502 })
    }
    return NextResponse.json({ status: 'ok' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return NextResponse.json({ error: 'Docling health check timed out' }, { status: 504 })
    }
    return NextResponse.json({ error: 'Docling sidecar is not reachable' }, { status: 502 })
  } finally {
    clearTimeout(timeout)
  }
}
