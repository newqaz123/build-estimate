"use client"

import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react"
import { ChevronsLeft, Expand, FileText, Shrink } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  MAX_REVIEW_SPLIT,
  MIN_REVIEW_SPLIT,
  clampReviewSplit,
  reviewSplitFromKey,
  reviewSplitFromPointer,
} from "@/lib/pdf-review-geometry"

type ReviewWorkspaceMode = "split" | "pdf-collapsed" | "pdf-full"

interface ReviewWorkspaceProps {
  pdf: ReactNode
  children: ReactNode
  sourceFileName: string
  hasSource?: boolean
  /** Starting PDF share of the split, in percent (default 50). */
  initialSplit?: number
}

export function ReviewWorkspace({ pdf, children, sourceFileName, hasSource = true, initialSplit = 50 }: ReviewWorkspaceProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const showPdfRef = useRef<HTMLButtonElement>(null)
  const fullPdfRef = useRef<HTMLButtonElement>(null)
  const exitFullPdfRef = useRef<HTMLButtonElement>(null)
  const [split, setSplit] = useState(() => clampReviewSplit(initialSplit))
  const [mode, setMode] = useState<ReviewWorkspaceMode>("split")
  const [isResizing, setIsResizing] = useState(false)

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = bodyRef.current?.getBoundingClientRect()
    if (bounds) setSplit(reviewSplitFromPointer(event.clientX, bounds))
  }

  const stopResize = () => setIsResizing(false)

  const releaseResizeCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    stopResize()
  }

  const handleSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = reviewSplitFromKey(split, event.key)
    if (next !== split) {
      event.preventDefault()
      setSplit(next)
    }
  }

  const focusAfterModeChange = (target: { current: HTMLButtonElement | null }) => {
    requestAnimationFrame(() => target.current?.focus())
  }

  return (
    <div
      ref={bodyRef}
      className={`review-body ${hasSource ? `review-workspace-${mode}` : "review-workspace-no-source"}${isResizing ? " is-resizing" : ""}`}
      data-od-id="review-workspace"
      style={
        hasSource && mode === "split"
          ? {
              gridTemplateColumns: `minmax(0, ${split}fr) 12px minmax(0, ${100 - split}fr)`,
            }
          : undefined
      }
    >
      {hasSource ? (
        <Button
        ref={showPdfRef}
        className="review-show-pdf"
        data-od-id="review-show-pdf"
        hidden={mode !== "pdf-collapsed"}
        size="sm"
        variant="outline"
        onClick={() => {
          setMode("split")
          focusAfterModeChange(collapseRef)
        }}
      >
        <FileText data-icon="inline-start" />Show PDF
        </Button>
      ) : null}

      {hasSource ? (
        <section
        className="review-pdf-col"
        data-od-id="review-pdf-panel"
        aria-label="Original BOQ PDF"
        hidden={mode === "pdf-collapsed"}
      >
        <div className="review-panel-toolbar">
          <span className="review-source-filename" title={sourceFileName}>
            {sourceFileName}
          </span>
          <span className="review-pdf-display-actions">
            {mode === "pdf-full" ? (
              <Button
                ref={exitFullPdfRef}
                data-od-id="review-exit-full-pdf"
                size="sm"
                variant="outline"
                onClick={() => {
                  setMode("split")
                  focusAfterModeChange(fullPdfRef)
                }}
              >
                <Shrink data-icon="inline-start" />Exit full PDF
              </Button>
            ) : (
              <>
                <Button
                  ref={collapseRef}
                  data-od-id="review-collapse-pdf"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setMode("pdf-collapsed")
                    focusAfterModeChange(showPdfRef)
                  }}
                >
                  <ChevronsLeft data-icon="inline-start" />Collapse
                </Button>
                <Button
                  ref={fullPdfRef}
                  data-od-id="review-full-pdf"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setMode("pdf-full")
                    focusAfterModeChange(exitFullPdfRef)
                  }}
                >
                  <Expand data-icon="inline-start" />Full PDF
                </Button>
              </>
            )}
          </span>
        </div>
        {pdf}
        </section>
      ) : null}

      {!hasSource ? null : (
        <div
        className="review-resize-handle"
        data-od-id="review-workspace-resizer"
        hidden={mode !== "split"}
        role="separator"
        tabIndex={0}
        aria-label="Resize PDF and matching panels"
        aria-orientation="vertical"
        aria-valuemin={MIN_REVIEW_SPLIT}
        aria-valuemax={MAX_REVIEW_SPLIT}
        aria-valuenow={Math.round(split)}
        onKeyDown={handleSeparatorKey}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setIsResizing(true)
          resize(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event)
        }}
        onPointerUp={releaseResizeCapture}
        onPointerCancel={releaseResizeCapture}
        onLostPointerCapture={stopResize}
      >
        <span aria-hidden="true" />
        </div>
      )}

      <section
        className="review-data-col"
        data-od-id="review-data-panel"
        aria-label="BOQ matching and missing data"
        hidden={mode === "pdf-full"}
      >
        {!hasSource ? (
          <div className="review-source-unavailable" role="status">
            <FileText aria-hidden="true" />
            <span><strong>Source PDF unavailable.</strong> This legacy BOQ can still be reviewed and exported.</span>
          </div>
        ) : null}
        {children}
      </section>
    </div>
  )
}
