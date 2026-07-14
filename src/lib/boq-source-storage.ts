import { getStorageBucket } from './firebase-admin'

export function boqSourcePath(boqId: string): string {
  return `boqs/${boqId}/source.pdf`
}

export async function saveSourcePdf(path: string, bytes: Uint8Array): Promise<void> {
  await getStorageBucket().file(path).save(Buffer.from(bytes), {
    resumable: false,
    public: false,
    metadata: {
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=0',
    },
  })
}

export async function loadSourcePdf(path: string): Promise<Buffer> {
  const [bytes] = await getStorageBucket().file(path).download()
  return bytes
}

export function isSourceObjectNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 404
}

export async function deleteSourcePdf(path: string): Promise<void> {
  await getStorageBucket().file(path).delete()
}
