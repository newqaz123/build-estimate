import assert from 'node:assert/strict'
import test from 'node:test'

import { createGcsPreflightStorageAdapter } from '@/lib/boq-preflight-storage-adapter'

test('GCS adapter saves source PDF and returns storage path', async () => {
  const savedPaths: Array<{ path: string; bytes: Uint8Array }> = []
  const mockBucket = {
    file: (path: string) => ({
      save: async (bytes: Uint8Array) => {
        savedPaths.push({ path, bytes: new Uint8Array(bytes) })
      },
    }),
  }

  const adapter = createGcsPreflightStorageAdapter({ bucket: mockBucket as any })

  const file = new File([Buffer.from('%PDF-1.4\n%')], 'test.pdf', { type: 'application/pdf' })
  const result = await adapter.saveSource(file, 'user-1', 'preflight-123')

  assert.equal(result, 'preflight/user-1/preflight-123/source.pdf')
  assert.equal(savedPaths.length, 1)
  assert.equal(savedPaths[0]?.path, 'preflight/user-1/preflight-123/source.pdf')
  assert.deepEqual(Buffer.from(savedPaths[0]?.bytes), Buffer.from('%PDF-1.4\n%'))
})

test('GCS adapter loads source PDF and returns File', async () => {
  const sourceBytes = Buffer.from('%PDF-1.4\n%')
  const mockBucket = {
    file: () => ({
      exists: async () => [true],
      download: async () => [new Uint8Array(sourceBytes)],
    }),
  }

  const adapter = createGcsPreflightStorageAdapter({ bucket: mockBucket as any })

  const result = await adapter.loadSource('user-1', 'preflight-123')

  assert.ok(result instanceof File)
  assert.equal(result.type, 'application/pdf')
  assert.equal(result.name, 'source.pdf')
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), sourceBytes)
})

test('GCS adapter load creates Blob from Buffer correctly', async () => {
  const sourceBytes = Buffer.from('%PDF-1.4\n%')
  let loadedAs: string = ''
  const mockBucket = {
    file: () => ({
      exists: async () => [true],
      download: async () => {
        loadedAs = typeof sourceBytes
        return [new Uint8Array(sourceBytes)]
      },
    }),
  }

  const adapter = createGcsPreflightStorageAdapter({ bucket: mockBucket as any })

  const result = await adapter.loadSource('user-1', 'preflight-123')

  assert.ok(result instanceof File, 'result must be a File')
  assert.equal(loadedAs, 'object')
})

test('GCS adapter throws on save error', async () => {
  const mockBucket = {
    file: () => ({
      save: async () => {
        throw new Error('Storage quota exceeded')
      },
    }),
  }

  const adapter = createGcsPreflightStorageAdapter({ bucket: mockBucket as any })

  const file = new File([Buffer.from('%PDF')], 'test.pdf', { type: 'application/pdf' })
  await assert.rejects(async () => await adapter.saveSource(file, 'user-1', 'preflight-123'), {
    message: 'Storage quota exceeded',
  })
})

test('GCS adapter throws on load error', async () => {
  const mockBucket = {
    file: () => ({
      exists: async () => [true],
      download: async () => {
        throw new Error('Object not found')
      },
    }),
  }

  const adapter = createGcsPreflightStorageAdapter({ bucket: mockBucket as any })

  await assert.rejects(async () => await adapter.loadSource('user-1', 'preflight-123'), {
    message: 'Object not found',
  })
})
