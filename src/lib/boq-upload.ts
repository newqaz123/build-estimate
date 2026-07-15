export function uploadRejectionMessage(errorCodes: string[]): string {
  if (errorCodes.includes('file-invalid-type')) {
    return 'Choose a PDF file. Other file types are not supported.'
  }
  if (errorCodes.includes('file-too-large')) return 'Choose a PDF smaller than 20 MB.'
  if (errorCodes.includes('too-many-files')) return 'Choose one PDF at a time.'
  return 'Choose one PDF smaller than 20 MB.'
}
