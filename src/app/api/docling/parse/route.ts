import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDocument } from '@/lib/db'
import { DoclingClientError, parsePdfWithDocling } from '@/lib/docling-client'
import type { WorkspaceSettings } from '@/lib/settings-schema'

const DEFAULT_DOCLING_ENDPOINT = 'http://localhost:5001'
const MAX_PDF_BYTES = 20 * 1024 * 1024

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'A PDF file is required' }, { status: 400 })
    }
    if (file.size === 0 || file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: 'PDF must be between 1 byte and 20 MB' }, { status: 400 })
    }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json({ error: 'Only PDF files are supported' }, { status: 400 })
    }

    const settings = await getDocument<WorkspaceSettings>('settings', 'workspace')
    const endpoint = settings?.docling?.endpoint || DEFAULT_DOCLING_ENDPOINT
    return NextResponse.json(await parsePdfWithDocling(file, endpoint))
  } catch (error) {
    if (error instanceof DoclingClientError) {
      const status = error.kind === 'timeout' ? 504 : 502
      const message = error.kind === 'unreachable'
        ? 'Docling sidecar is not reachable. Check the endpoint in Settings.'
        : error.message
      return NextResponse.json({ error: message }, { status })
    }
    return NextResponse.json({ error: 'Invalid upload request' }, { status: 400 })
  }
}
