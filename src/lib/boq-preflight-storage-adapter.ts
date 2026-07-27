import type { Bucket } from '@google-cloud/storage'

export interface PreflightStorageAdapter {
  saveSource(file: File, ownerId: string, id: string): Promise<string>
  loadSource(ownerId: string, id: string): Promise<File>
}

export interface PreflightStorageAdapterDependencies {
  bucket: Bucket
}

/**
 * GCS adapter for preflight source PDF storage.
 * Handles save/load of source PDFs with proper Blob conversion.
 */
export function createGcsPreflightStorageAdapter(
  dependencies: PreflightStorageAdapterDependencies,
): PreflightStorageAdapter {
  const { bucket } = dependencies

  function artifactPath(ownerId: string, id: string): string {
    return `preflight/${ownerId}/${id}/source.pdf`
  }

  return {
    async saveSource(file: File, ownerId: string, id: string): Promise<string> {
      const path = artifactPath(ownerId, id)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const fileObj = bucket.file(path)

      await fileObj.save(bytes, {
        contentType: 'application/pdf',
        metadata: {
          originalName: file.name,
          uploadedAt: new Date().toISOString(),
        },
      })

      return path
    },

    async loadSource(ownerId: string, id: string): Promise<File> {
      const path = artifactPath(ownerId, id)
      const fileObj = bucket.file(path)

      const [exists] = await fileObj.exists()
      if (!exists) {
        throw new Error(`Source PDF not found: ${path}`)
      }

      const [buffer] = await fileObj.download()

      // CRITICAL FIX: Convert Buffer to Blob using new Blob([new Uint8Array(buffer)])
      // Buffer is not a BlobPart under these TypeScript libraries
      const blob = new Blob([new Uint8Array(buffer)], { type: 'application/pdf' })

      return new File([blob], 'source.pdf', { type: 'application/pdf' })
    },
  }
}
