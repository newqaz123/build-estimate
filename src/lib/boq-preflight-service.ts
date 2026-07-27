import { randomUUID } from 'node:crypto'

import { requireSinglePdf } from '@/lib/boq-import-request'
import type { PreflightUpload, PreflightPage, PreflightTextSource } from '@/lib/boq-preflight-schema'
import type { PreflightStore, PreflightCreateInput } from '@/lib/boq-preflight-storage'

export interface PreflightServiceDependencies {
  store: PreflightStore
  analysisAdapter: AnalysisAdapter
  storageAdapter: StorageAdapter
  now: () => Date
}

export interface AnalysisAdapter {
  renderAndAnalyze(file: File, signal: AbortSignal): Promise<{ pageCount: number; pages: PreflightPage[] }>
  renderPreview(file: File, pageNumber: number): Promise<Buffer>
}

export interface StorageAdapter {
  saveSourcePdf(ownerId: string, id: string, file: File): Promise<string>
  loadSourcePdf(path: string): Promise<File>
}

export interface CreatePreflightResult {
  id: string
  fileName: string
  pageCount: number
  status: PreflightUpload['status']
  pages: PreflightPage[]
}

export interface ConsumePreflightResult {
  file: File
  pages: number[]
  preflightId: string
}

export function createPreflightService(dependencies: PreflightServiceDependencies) {
  return {
    async createPreflight(file: File, actorId: string): Promise<CreatePreflightResult> {
      const formData = new FormData()
      formData.append('file', file)
      requireSinglePdf(formData)

      const id = randomUUID()
      const signal = AbortSignal.timeout(120_000)

      const sourcePath = await dependencies.storageAdapter.saveSourcePdf(actorId, id, file)

      let pageCount = 0
      let pages: PreflightPage[] = []

      try {
        const analysis = await dependencies.analysisAdapter.renderAndAnalyze(file, signal)
        pageCount = analysis.pageCount
        pages = analysis.pages
      } catch {
        pageCount = 1
        pages = [{
          page: 1,
          suggested: false,
          confidence: 0,
          reasons: [],
          textSource: 'unavailable' as PreflightTextSource,
        }]
      }

      const input: PreflightCreateInput = {
        id,
        ownerId: actorId,
        fileName: file.name,
        pageCount,
        status: 'ready',
        pages,
        confirmedPages: null,
        sourceDigest: sourcePath,
        sourceName: file.name,
        sourceType: file.type,
        sourceSize: file.size,
      }

      await dependencies.store.create(input)

      return {
        id,
        fileName: file.name,
        pageCount,
        status: 'ready',
        pages,
      }
    },

    async consumePreflight(id: string, actorId: string, selection: { pages: number[] }): Promise<ConsumePreflightResult> {
      const record = await dependencies.store.getOwned(id, actorId)
      if (!record) {
        throw new Error('Preflight upload not found')
      }

      if (record.status !== 'ready') {
        throw new Error('Preflight upload is not ready for consumption')
      }

      const validated = parseConfirmedPageSelection(selection, record.pageCount)
      await dependencies.store.update(id, actorId, {
        status: 'consumed',
        confirmedPages: validated.pages,
      })

      const file = await dependencies.storageAdapter.loadSourcePdf(record.sourceDigest)

      return {
        file,
        pages: validated.pages,
        preflightId: id,
      }
    },

    async cancelPreflight(id: string, actorId: string): Promise<void> {
      const record = await dependencies.store.getOwned(id, actorId)
      if (!record) {
        throw new Error('Preflight upload not found')
      }

      await dependencies.store.update(id, actorId, { status: 'cancelled' })
    },
  }
}

function parseConfirmedPageSelection(value: unknown, pageCount: number): { pages: number[] } {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error('pageCount must be a positive integer')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('value must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => key !== 'pages')) {
    throw new Error('unknown keys are not allowed')
  }
  if (!Array.isArray(record.pages)) {
    throw new Error('pages must be an array')
  }
  if (record.pages.length === 0) {
    throw new Error('at least one page must be selected')
  }

  const pages = record.pages.map((page) => {
    if (!Number.isInteger(page)) {
      throw new Error('pages must contain only integer page numbers')
    }
    if ((page as number) < 1 || (page as number) > pageCount) {
      throw new Error(`pages must be between 1 and ${pageCount}`)
    }
    return page as number
  })
  return { pages: [...new Set(pages)].sort((left, right) => left - right) }
}
