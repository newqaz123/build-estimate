"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, ArrowLeftRight, Upload } from "lucide-react"

import { summarizeComponentComparison } from "@/components/boq-catalog-component-table"
import { ProtoBadge } from "@/components/proto-badge"
import { UploadModal } from "@/components/upload-modal"
import type { Boq } from "@/lib/boq-schema"
import type { BoqCatalogComparisonRow } from "@/lib/boq-catalog-comparison"
import { getBoqCatalogReadiness } from "@/lib/boq-catalog-readiness"
import { resolveCompareBoqId } from "@/lib/compare-boq-selection"
import { boqWorkspaceHref, compareBoqHref } from "@/lib/boq-review-route"

type ComparisonResponse = { boqId: string; rows: BoqCatalogComparisonRow[] }

type BoqLoadState = "loading" | "loaded" | "error"
type ComparisonLoadState = "idle" | "loading" | "loaded" | "error"

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function formatVariance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}%`
}

function boqNeedsReview(boq: Boq): boolean {
  return boq.status !== "approved" || getBoqCatalogReadiness(boq).blocking > 0
}

export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <div className="proto-loading-state compare-state" role="status">
          <div>
            <span className="proto-spinner" aria-hidden="true" />
            Loading comparison workspace…
          </div>
        </div>
      }
    >
      <ComparePageContent />
    </Suspense>
  )
}

function ComparePageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const preferredBoqId = searchParams.get("boq")
  const [boqs, setBoqs] = useState<Boq[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null)
  const [boqLoadState, setBoqLoadState] = useState<BoqLoadState>("loading")
  const [comparisonLoadState, setComparisonLoadState] = useState<ComparisonLoadState>("idle")
  const [uploadOpen, setUploadOpen] = useState(false)
  const boqRequestRef = useRef<AbortController | null>(null)
  const comparisonRequestRef = useRef<AbortController | null>(null)

  const loadBoqs = useCallback(async (preferredId?: string | null) => {
    boqRequestRef.current?.abort()
    comparisonRequestRef.current?.abort()

    const controller = new AbortController()
    boqRequestRef.current = controller
    setBoqLoadState("loading")
    setComparison(null)
    setComparisonLoadState("idle")

    try {
      const response = await fetch("/api/boqs?limit=1000", {
        signal: controller.signal,
      })
      if (!response.ok) throw new Error("BOQs could not be loaded")

      const data = await response.json() as { boqs?: Boq[] }
      if (
        controller.signal.aborted
        || boqRequestRef.current !== controller
      ) {
        return
      }

      const next = data.boqs ?? []
      setBoqs(next)
      setSelectedId((current) =>
        resolveCompareBoqId(next, preferredId, current),
      )
      setBoqLoadState("loaded")
    } catch (error) {
      if (
        controller.signal.aborted
        || boqRequestRef.current !== controller
        || isAbortError(error)
      ) {
        return
      }

      setBoqLoadState("error")
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => loadBoqs(preferredBoqId))
    return () => {
      boqRequestRef.current?.abort()
    }
  }, [loadBoqs, preferredBoqId])

  const selected = boqs.find((boq) => boq.id === selectedId)

  const loadComparison = useCallback(
    async (boqId: string): Promise<boolean> => {
      comparisonRequestRef.current?.abort()

      if (!boqId) {
        setComparison(null)
        setComparisonLoadState("idle")
        return false
      }

      const controller = new AbortController()
      comparisonRequestRef.current = controller
      setComparison(null)
      setComparisonLoadState("loading")

      try {
        const response = await fetch(
          `/api/boqs/${encodeURIComponent(boqId)}/comparison`,
          { signal: controller.signal },
        )
        if (!response.ok) {
          throw new Error("Comparison could not be loaded")
        }

        const next = await response.json() as ComparisonResponse
        if (
          controller.signal.aborted
          || comparisonRequestRef.current !== controller
        ) {
          return false
        }

        setComparison(next)
        setComparisonLoadState("loaded")
        return true
      } catch (error) {
        if (
          controller.signal.aborted
          || comparisonRequestRef.current !== controller
          || isAbortError(error)
        ) {
          return false
        }

        setComparison(null)
        setComparisonLoadState("error")
        return false
      }
    },
    [],
  )

  useEffect(() => {
    if (boqLoadState !== "loaded" || !selected) {
      comparisonRequestRef.current?.abort()
      return
    }

    void Promise.resolve().then(() => loadComparison(selected.id))
    return () => {
      comparisonRequestRef.current?.abort()
    }
  }, [boqLoadState, loadComparison, selected])

  const handleSelectionChange = (nextId: string) => {
    comparisonRequestRef.current?.abort()
    setSelectedId(nextId)
    setComparison(null)
    setComparisonLoadState("idle")
  }

  const handleUploadComplete = (boq: Boq) => {
    setUploadOpen(false)
    router.push(
      boqWorkspaceHref(boq.id, "review", compareBoqHref(boq.id))
    )
  }

  const rows = comparison?.rows ?? []
  const comparisonSummary = summarizeComponentComparison(rows, selected?.grandTotal ?? 0)
  const selectedReadiness = selected ? getBoqCatalogReadiness(selected) : null
  const selectedIsApproved = selected?.status === "approved"
  const hasReviewIssues = Boolean(
    selected
    && (!selectedIsApproved || (selectedReadiness?.blocking ?? 0) > 0),
  )
  const inboxNeedsReview = boqs.reduce(
    (count, boq) => count + (boqNeedsReview(boq) ? 1 : 0),
    0,
  )
  const inboxUnmatchedLines = boqs.reduce(
    (sum, boq) => sum + getBoqCatalogReadiness(boq).blocking,
    0,
  )
  const provisionalMaterialVariance = comparisonLoadState === "loaded"
    ? comparisonSummary.materialVariancePct
    : null

  return (
    <div className="compare-page" data-od-id="compare-page">
      <section className="compare-summary-section">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-heading text-xl font-medium">Comparison Inbox</h1>
            <p className="compare-intro">
              One vendor BOQ at a time. Select a recent parse for a provisional snapshot, then open the full comparison in the BOQ workspace.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm w-full sm:w-auto"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="w-4 h-4" /> Upload BOQ
          </button>
        </div>
        <div className="compare-summary">
          <div className="proto-card stat-card">
            <div className="stat-value num">{inboxNeedsReview}</div>
            <div className="stat-label">Needs review</div>
          </div>
          <div className="proto-card stat-card">
            <div className="stat-value num">{inboxUnmatchedLines}</div>
            <div className="stat-label">Unmatched lines</div>
          </div>
          <div className="proto-card stat-card">
            <div className="stat-value num">{formatVariance(provisionalMaterialVariance)}</div>
            <div className="stat-label">Provisional material</div>
          </div>
          <div className="proto-card stat-card">
            <div className="stat-value num">{boqs.length}</div>
            <div className="stat-label">Recent BOQs</div>
          </div>
        </div>
      </section>

      {boqLoadState === "loading" ? (
        <div className="proto-loading-state compare-state" role="status">
          <div><span className="proto-spinner" aria-hidden="true" /> Loading BOQs…</div>
        </div>
      ) : null}
      {boqLoadState === "error" ? (
        <div className="proto-empty-state proto-error-state compare-state" role="alert">
          <AlertCircle /><h3>Couldn&apos;t load BOQs</h3><p>Try again in a moment.</p>
          <button className="btn btn-secondary" onClick={() => void loadBoqs(preferredBoqId)}>Retry</button>
        </div>
      ) : null}
      {boqLoadState === "loaded" && boqs.length === 0 ? (
        <div className="proto-empty-state compare-state">
          <ArrowLeftRight />
          <h3>No BOQ selected</h3>
          <p>Upload a BOQ PDF to parse, review, and compare it with the catalog.</p>
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>Upload BOQ</button>
        </div>
      ) : null}

      {boqLoadState === "loaded" && boqs.length > 0 ? (
        <div className="compare-inbox" data-od-id="compare-inbox">
          <div className="proto-card p-4">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="font-heading text-base font-medium">Recent BOQs</h2>
              <span className="text-xs text-muted-foreground">{boqs.length} total</span>
            </div>
            <ul className="compare-inbox-list" role="list">
              {boqs.map((boq) => {
                const readiness = getBoqCatalogReadiness(boq)
                const isSelected = selected?.id === boq.id
                return (
                  <li key={boq.id} role="listitem">
                    <button
                      type="button"
                      className={isSelected ? "is-selected" : undefined}
                      aria-pressed={isSelected}
                      onClick={() => handleSelectionChange(boq.id)}
                    >
                      <strong>{boq.project || "Untitled BOQ"}</strong>
                      <span>{boq.vendor}</span>
                      <ProtoBadge status={boq.status} />
                      <span>{readiness.blocking} unmatched</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="proto-card p-4" data-od-id="compare-selected-snapshot">
            {selected ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      Selected snapshot
                    </p>
                    <h2 className="mt-1 font-heading text-lg font-medium">
                      {selected.project || "Untitled BOQ"}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">{selected.vendor}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <ProtoBadge status={selected.status} />
                      <span className="text-sm text-muted-foreground">
                        {selectedReadiness?.blocking ?? 0} unmatched
                      </span>
                    </div>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                    <Link
                      data-od-id="compare-open-comparison"
                      href={boqWorkspaceHref(
                        selected.id,
                        "compare",
                        compareBoqHref(selected.id),
                      )}
                      className="btn btn-primary w-full sm:w-auto"
                    >
                      Open comparison
                    </Link>
                    {hasReviewIssues ? (
                      <Link
                        data-od-id="compare-review-issues"
                        href={boqWorkspaceHref(
                          selected.id,
                          "review",
                          compareBoqHref(selected.id),
                        )}
                        className="btn btn-secondary w-full sm:w-auto"
                      >
                        Review issues
                      </Link>
                    ) : null}
                  </div>
                </div>

                {comparisonLoadState === "loading" ? (
                  <div className="proto-loading-state compare-state mt-4" role="status">
                    <div>
                      <span className="proto-spinner" aria-hidden="true" />
                      Loading provisional comparison…
                    </div>
                  </div>
                ) : null}
                {comparisonLoadState === "error" ? (
                  <div className="proto-empty-state proto-error-state compare-state mt-4" role="alert">
                    <AlertCircle />
                    <h3>Couldn&apos;t load this comparison</h3>
                    <p>Your BOQ has not been changed.</p>
                    <button
                      className="btn btn-secondary"
                      onClick={() => void loadComparison(selectedId)}
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                {comparisonLoadState === "loaded" ? (
                  <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <span className="text-muted-foreground">Material vs catalog</span>
                      <div className="font-mono text-base num">
                        {formatVariance(comparisonSummary.materialVariancePct)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Labour vs catalog</span>
                      <div className="font-mono text-base num">
                        {formatVariance(comparisonSummary.labourVariancePct)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Component lines</span>
                      <div className="font-mono text-base num">
                        {comparisonSummary.componentLines}/{comparisonSummary.totalLines}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Catalog-ready</span>
                      <div className="font-mono text-base num">
                        {selectedReadiness?.resolved ?? 0}/{selectedReadiness?.total ?? 0}
                      </div>
                    </div>
                  </div>
                ) : null}
                <p className="mt-4 text-xs text-muted-foreground">
                  Full comparison stays in the BOQ workspace. This inbox is read-only triage.
                </p>
              </>
            ) : (
              <div className="proto-empty-state compare-state">
                <ArrowLeftRight />
                <h3>Select a BOQ</h3>
                <p>Choose a recent BOQ to see its provisional comparison snapshot.</p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <UploadModal open={uploadOpen} onOpenChange={setUploadOpen} onUploadComplete={handleUploadComplete} />
    </div>
  )
}
