export interface PdfPoint { x: number; y: number }
export interface PdfSize { width: number; height: number }
export interface PdfRect extends PdfPoint, PdfSize {}

export const MIN_REVIEW_SPLIT = 25
export const MAX_REVIEW_SPLIT = 75
export const MIN_BOX_SELECTION = 8
export const MIN_PDF_ZOOM = 1
export const MAX_PDF_ZOOM = 8

export function clampReviewSplit(value: number): number {
  return Math.min(MAX_REVIEW_SPLIT, Math.max(MIN_REVIEW_SPLIT, value))
}

export function reviewSplitFromPointer(
  clientX: number,
  bounds: { left: number; width: number },
): number {
  if (bounds.width <= 0) return 50
  return clampReviewSplit(((clientX - bounds.left) / bounds.width) * 100)
}

export function reviewSplitFromKey(current: number, key: string): number {
  if (key === "ArrowLeft") return clampReviewSplit(current - 5)
  if (key === "ArrowRight") return clampReviewSplit(current + 5)
  if (key === "Home") return MIN_REVIEW_SPLIT
  if (key === "End") return MAX_REVIEW_SPLIT
  return current
}

export function normalizeSelection(start: PdfPoint, end: PdfPoint): PdfRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function clampPdfPan(
  pan: PdfPoint,
  page: PdfSize,
  viewport: PdfSize,
): PdfPoint {
  const maxX = Math.max(0, (page.width - viewport.width) / 2)
  const maxY = Math.max(0, (page.height - viewport.height) / 2)
  const clampAxis = (value: number, maximum: number) => maximum === 0
    ? 0
    : Math.min(maximum, Math.max(-maximum, value))
  return {
    x: clampAxis(pan.x, maxX),
    y: clampAxis(pan.y, maxY),
  }
}

export function pdfPageBounds(
  viewport: PdfSize,
  page: PdfSize,
  pan: PdfPoint,
): PdfRect {
  return {
    x: (viewport.width - page.width) / 2 + pan.x,
    y: (viewport.height - page.height) / 2 + pan.y,
    width: page.width,
    height: page.height,
  }
}

export function clipSelectionToPage(selection: PdfRect, page: PdfRect): PdfRect | null {
  const left = Math.max(selection.x, page.x)
  const top = Math.max(selection.y, page.y)
  const right = Math.min(selection.x + selection.width, page.x + page.width)
  const bottom = Math.min(selection.y + selection.height, page.y + page.height)
  const clipped = { x: left, y: top, width: right - left, height: bottom - top }
  return clipped.width >= MIN_BOX_SELECTION && clipped.height >= MIN_BOX_SELECTION
    ? clipped
    : null
}

export function deriveBoxZoom({
  selection,
  viewport,
  zoom,
  pan,
}: {
  selection: PdfRect
  viewport: PdfSize
  zoom: number
  pan: PdfPoint
}): { zoom: number; pan: PdfPoint } | null {
  if (selection.width < MIN_BOX_SELECTION || selection.height < MIN_BOX_SELECTION) return null
  const requestedFactor = Math.min(
    viewport.width / selection.width,
    viewport.height / selection.height,
  )
  const nextZoom = Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, zoom * requestedFactor))
  const appliedFactor = nextZoom / zoom
  const centerX = selection.x + selection.width / 2
  const centerY = selection.y + selection.height / 2
  return {
    zoom: nextZoom,
    pan: {
      x: appliedFactor * (viewport.width / 2 + pan.x - centerX),
      y: appliedFactor * (viewport.height / 2 + pan.y - centerY),
    },
  }
}

export function panPdf(current: PdfPoint, delta: PdfPoint): PdfPoint {
  return { x: current.x + delta.x, y: current.y + delta.y }
}
