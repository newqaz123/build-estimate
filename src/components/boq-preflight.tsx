"use client"

import { useState, useCallback } from "react"
import { ZoomIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PreflightUpload } from "@/lib/boq-preflight-schema"

interface BoqPreflightProps {
  preflight: PreflightUpload
  onExtract: (pages: number[]) => void
  onCancel: () => void
}

export function BoqPreflight({ preflight, onExtract, onCancel }: BoqPreflightProps) {
  const [selectedPages, setSelectedPages] = useState<number[]>(() =>
    preflight.pages.filter((p: { suggested: boolean }) => p.suggested).map((p: { page: number }) => p.page)
  )
  const [magnifiedPage, setMagnifiedPage] = useState<number | null>(null)

  const toggleSelection = useCallback((page: number) => {
    setSelectedPages((prev) =>
      prev.includes(page)
        ? prev.filter((p) => p !== page)
        : [...prev, page].sort((a, b) => a - b)
    )
  }, [])

  const handleExtract = () => {
    onExtract(selectedPages)
  }

  const buildAccessibleLabel = (pageInfo: { page: number; suggested: boolean }): string => {
    const isSelected = selectedPages.includes(pageInfo.page)
    const baseLabel = `Page ${pageInfo.page}`
    const states: string[] = []
    if (pageInfo.suggested) states.push("suggested")
    states.push(isSelected ? "selected" : "not selected")
    return `${baseLabel}, ${states.join(", ")}`
  }

  return (
    <div className="preflight-container">
      <div className="preflight-header">
        <h3>Select pages to extract</h3>
        <p className="preflight-description">
          Confirm which pages from {preflight.fileName} contain BOQ line items.
        </p>
      </div>

      <div className="preflight-pages">
        {preflight.pages.map((pageInfo) => {
          const isSelected = selectedPages.includes(pageInfo.page)
          const isMagnified = magnifiedPage === pageInfo.page
          const accessibleLabel = buildAccessibleLabel(pageInfo)

          return (
            <div key={pageInfo.page} className="preflight-page-item">
              <button
                type="button"
                role="button"
                aria-label={accessibleLabel}
                aria-pressed={isSelected}
                onClick={() => toggleSelection(pageInfo.page)}
                onMouseEnter={() => setMagnifiedPage(pageInfo.page)}
                onMouseLeave={() => setMagnifiedPage(null)}
                onFocus={() => setMagnifiedPage(pageInfo.page)}
                onBlur={() => setMagnifiedPage(null)}
                className={`preflight-thumbnail ${isSelected ? "is-selected" : ""} ${
                  isMagnified ? "is-magnified" : ""
                }`}
              >
                <span className="preflight-thumbnail-number">{pageInfo.page}</span>
                {pageInfo.suggested && (
                  <span className="preflight-thumbnail-badge">Suggested</span>
                )}
                {isSelected && (
                  <span className="preflight-thumbnail-check" aria-hidden="true">✓</span>
                )}
              </button>

              {isMagnified && (
                <div
                  role="img"
                  aria-label={`Magnified Page ${pageInfo.page}`}
                  className="preflight-magnifier"
                >
                  <img
                    src={`/api/boqs/preflight/${preflight.id}/preview?page=${pageInfo.page}`}
                    alt={`Magnified preview of page ${pageInfo.page}`}
                    className="preflight-magnifier-image"
                  />
                  <div className="preflight-magnifier-info">
                    <span className="preflight-magnifier-icon"><ZoomIn size={16} /></span>
                    <span>Page {pageInfo.page}</span>
                    {pageInfo.suggested && (
                      <span className="preflight-magnifier-badge">Suggested</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="preflight-actions">
        <div className="preflight-status">
          {selectedPages.length === 0 ? (
            <p className="preflight-error">Select at least one page to continue.</p>
          ) : (
            <p className="preflight-count">
              {selectedPages.length} page{selectedPages.length !== 1 ? "s" : ""} selected
            </p>
          )}
        </div>

        <div className="preflight-buttons">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleExtract}
            disabled={selectedPages.length === 0}
          >
            Extract {selectedPages.length} selected page{selectedPages.length !== 1 ? "s" : ""}
          </Button>
        </div>
      </div>
    </div>
  )
}
