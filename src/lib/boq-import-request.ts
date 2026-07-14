import { DoclingClientError } from './docling-client'

const MAX_PDF_BYTES = 20 * 1024 * 1024
const INVALID_PDF_MESSAGE = 'Upload one PDF between 1 byte and 20 MB.'

export function requireSinglePdf(formData: FormData): File {
  const files = formData.getAll('file')
  const file = files[0]
  const valid = files.length === 1
    && file instanceof File
    && file.size >= 1
    && file.size <= MAX_PDF_BYTES
    && file.name.toLowerCase().endsWith('.pdf')
    && file.type.toLowerCase() === 'application/pdf'
  if (!valid) throw new TypeError(INVALID_PDF_MESSAGE)
  return file
}

export function invalidPdfResponse(): Response {
  return Response.json({ error: INVALID_PDF_MESSAGE }, { status: 400 })
}

export function doclingErrorResponse(error: DoclingClientError): Response {
  switch (error.kind) {
    case 'cancelled':
      return Response.json({ error: 'Request cancelled.' }, { status: 499 })
    case 'timeout':
      return Response.json({ error: 'Docling parsing timed out. Try the import again.' }, { status: 504 })
    case 'rejected':
      return Response.json({ error: error.message }, { status: 422 })
    case 'unreachable':
      return Response.json(
        { error: 'Docling is unreachable. Check the Docling endpoint in Settings and try again.' },
        { status: 502 },
      )
    case 'upstream':
      return Response.json({ error: 'Docling failed while processing the PDF. Try again.' }, { status: 502 })
    case 'invalid_response':
      return Response.json(
        { error: 'Docling returned an invalid response. Check the sidecar and try again.' },
        { status: 502 },
      )
  }
}
