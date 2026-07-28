import type { PreflightPageInput } from './boq-preflight-analysis'

export interface PdfjsPageText {
  pageNum: number
  textItems: Array<{ str: string } | null | undefined> | null | undefined
}

export interface PdfjsGeometrySignal {
  tableCount: number
  numericTokenCount: number
}

/**
 * Pure helper that maps pdfjs-dist per-page text output to analyzePreflightPages input format.
 * This function is pure and deterministic, making it easy to test without real PDFs.
 */
export function mapPdfjsToPreflightInput(
  pages: readonly PdfjsPageText[],
  geometrySignal: PdfjsGeometrySignal,
): PreflightPageInput[] {
  return pages.map((page) => {
    const textItems = page.textItems ?? []
    const embeddedText = textItems
      .map((item) => (item?.str ?? '').trim())
      .filter(Boolean)
      .join(' ')

    return {
      page: page.pageNum,
      embeddedText,
      geometry: geometrySignal,
    }
  })
}

export interface PreflightAnalysisAdapter {
  analyzePdf(file: File, signal?: AbortSignal): Promise<PreflightPageInput[]>
}

/**
 * Create a real adapter using pdfjs-dist to extract text from PDFs.
 * This adapter loads the PDF, extracts per-page text content, and maps it to the analysis input format.
 */
export function createPreflightAnalysisAdapter(): PreflightAnalysisAdapter {

  return {
    async analyzePdf(file: File, signal?: AbortSignal): Promise<PreflightPageInput[]> {
      const bytes = await file.arrayBuffer()

      // Dynamically import pdfjs-dist to avoid issues in environments where it's not available
      const pdfjsLib = await import('pdfjs-dist')

      // Load the PDF document
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(bytes),
        disableFontFace: true,
        useSystemFonts: true,
        useWorkerFetch: false,
      })

      // Support AbortSignal if provided
      if (signal) {
        signal.addEventListener('abort', () => loadingTask.destroy(), { once: true })
      }

      const pdf = await loadingTask.promise
      const pageCount = pdf.numPages

      const pages: PreflightPageInput[] = []

      for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        if (signal?.aborted) {
          throw new DOMException('Analysis aborted', 'AbortError')
        }

        const page = await pdf.getPage(pageNum)
        const textContent = await page.getTextContent()

        const textItems = textContent.items.map((item) => ({
          str: 'str' in item ? (item.str ?? '') : '',
        }))

        pages.push({
          page: pageNum,
          embeddedText: textItems.map((t) => t.str).join(' '),
          geometry: {
            tableCount: 0,
            numericTokenCount: 0,
          },
        })
      }

      // Cleanup
      await loadingTask.destroy()

      return pages
    },
  }
}
