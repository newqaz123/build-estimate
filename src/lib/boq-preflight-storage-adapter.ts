import type { Bucket } from '@google-cloud/storage'
import type { StorageAdapter } from '@/lib/boq-preflight-service'

export function createPreflightStorageAdapter(bucket: Bucket): StorageAdapter {
  return {
    async saveSourcePdf(ownerId: string, id: string, file: File): Promise<string> {
      const path = `preflight/${ownerId}/${id}/source.pdf`
      const buffer = new Uint8Array(await file.arrayBuffer())
      const fileObj = bucket.file(path)
      await fileObj.save(buffer, {
        contentType: 'application/pdf',
      })
      return path
    },
    async loadSourcePdf(path: string): Promise<File> {
      const file = bucket.file(path)
      const [exists] = await file.exists()
      if (!exists) {
        throw new Error('Source PDF not found')
      }
      const [buffer] = await file.download()
      return new File([buffer], 'source.pdf', { type: 'application/pdf' })
    },
  }
}
