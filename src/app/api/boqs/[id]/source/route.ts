import type { NextRequest } from 'next/server'

import { auth } from '@/lib/auth'
import { isSourceObjectNotFound, loadSourcePdf } from '@/lib/boq-source-storage'
import type { Boq } from '@/lib/boq-schema'
import { getDocument } from '@/lib/db'

type RouteContext = { params: Promise<{ id: string }> }

interface SourceHandlerDependencies {
  authenticate(): Promise<{ user?: unknown } | null>
  getBoq(id: string): Promise<Boq | null>
  loadSource(path: string): Promise<Buffer>
}

function encodedFilename(filename: string): string {
  const unicodeSafe = Array.from(filename, (character) => {
    const code = character.charCodeAt(0)
    return character.length === 1 && code >= 0xD800 && code <= 0xDFFF ? '\uFFFD' : character
  }).join('')
  return encodeURIComponent(unicodeSafe).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function contentDisposition(sourceFileName?: string): string {
  const filename = sourceFileName?.trim() || 'source.pdf'
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[\r\n]/g, '_')
  return `inline; filename="${ascii || 'source.pdf'}"; filename*=UTF-8''${encodedFilename(filename)}`
}

export function createSourceHandler(dependencies: SourceHandlerDependencies) {
  return async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
    const session = await dependencies.authenticate()
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    try {
      const { id } = await params
      const boq = await dependencies.getBoq(id)
      if (!boq?.sourceStoragePath) {
        return Response.json({ error: 'BOQ source not found' }, { status: 404 })
      }

      let bytes: Buffer
      try {
        bytes = await dependencies.loadSource(boq.sourceStoragePath)
      } catch (error) {
        if (isSourceObjectNotFound(error)) {
          return Response.json({ error: 'BOQ source not found' }, { status: 404 })
        }
        console.error('Error loading BOQ source:', error)
        return Response.json({ error: 'Internal server error' }, { status: 500 })
      }

      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': contentDisposition(boq.sourceFileName),
          'Cache-Control': 'private, no-store',
        },
      })
    } catch (error) {
      console.error('Error fetching BOQ source:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}

const sourceHandler = createSourceHandler({
  authenticate: auth,
  getBoq: (id) => getDocument<Boq>('boqs', id),
  loadSource: loadSourcePdf,
})

export async function GET(request: NextRequest, context: RouteContext) {
  return sourceHandler(request, context)
}
