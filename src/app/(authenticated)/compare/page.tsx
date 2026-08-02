"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, ArrowLeftRight, Upload } from "lucide-react"
import { toast } from "sonner"

import { BoqCatalogComponentTable, summarizeComponentComparison } from "@/components/boq-catalog-component-table"
import { CatalogMatchModal } from "@/components/catalog-match-modal"
import { ProtoBadge } from "@/components/proto-badge"
import { UploadModal } from "@/components/upload-modal"
import type { Boq } from "@/lib/boq-schema"
import type { BoqCatalogComparisonRow } from "@/lib/boq-catalog-comparison"
import { getBoqCatalogReadiness } from "@/lib/boq-catalog-readiness"
import { resolveCompareBoqId } from "@/lib/compare-boq-selection"
import { boqComparisonReviewHref } from "@/lib/boq-review-route"

type ComparisonResponse = { boqId: string; rows: BoqCatalogComparisonRow[] }

type BoqLoadState = "loading" | "loaded" | "error"
type ComparisonLoadState = "idle" | "loading" | "loaded" | "error"

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function currency(value: number) {
  return `฿${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatVariance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}%`
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
  const [matchTarget, setMatchTarget] = useState<BoqCatalogComparisonRow | null>(null)
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
    if (
      boqLoadState !== "loaded"
      || !selected
      || selected.status !== "approved"
    ) {
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
    router.push(boqComparisonReviewHref(boq.id))
  }

  const rows = comparison?.rows ?? []
  const comparisonSummary = summarizeComponentComparison(rows, selected?.grandTotal ?? 0)
  const selectedReadiness = selected ? getBoqCatalogReadiness(selected) : null

  return (
    <div className="compare-page" data-od-id="compare-page">
      <section className="compare-summary-section">
        <p className="compare-intro">Upload or select one BOQ, then compare each parsed line against the Standard Catalog and historical rates from other matched BOQs.</p>
        <div className="compare-summary">
          <div className="proto-card stat-card"><div className="stat-value num">{formatVariance(comparisonSummary.materialVariancePct)}</div><div className="stat-label">Material rate vs catalog</div></div>
          <div className="proto-card stat-card"><div className="stat-value num">{formatVariance(comparisonSummary.labourVariancePct)}</div><div className="stat-label">Labour rate vs catalog</div></div>
          <div className="proto-card stat-card"><div className="stat-value num">{comparisonSummary.componentLines}/{comparisonSummary.totalLines}</div><div className="stat-label">Lines with component data</div></div>
          <div className="proto-card stat-card"><div className="stat-value num">{currency(comparisonSummary.boqTotal)}</div><div className="stat-label">BOQ total</div></div>
        </div>
      </section>

      <div className="proto-toolbar compare-toolbar">
        <div className="proto-toolbar-left compare-baseline">
          <label htmlFor="compare-boq" className="compare-control-label">BOQ:</label>
          <select id="compare-boq" className="input compare-baseline-select" value={selectedId} onChange={(event) => handleSelectionChange(event.target.value)}>
            {boqs.map((boq) => <option key={boq.id} value={boq.id}>{boq.project} — {boq.vendor}</option>)}
          </select>
          {selected ? <ProtoBadge status={selected.status} /> : null}
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setUploadOpen(true)}><Upload className="w-4 h-4" /> Upload BOQ to compare</button>
      </div>

      {boqLoadState === "loading" ? (
        <div className="proto-loading-state compare-state" role="status">
          <div><span className="proto-spinner" aria-hidden="true" /> Loading BOQs…</div>
        </div>
      ) : null}
      {boqLoadState === "error" ? (
        <div className="proto-empty-state proto-error-state compare-state" role="alert">
          <AlertCircle /><h3>Couldn&apos;t load BOQs</h3><p>Try again in a moment.</p>
          <button className="btn btn-secondary" onClick={() => void loadBoqs()}>Retry</button>
        </div>
      ) : null}
      {boqLoadState === "loaded" && boqs.length === 0 ? (
        <div className="proto-empty-state compare-state"><ArrowLeftRight /><h3>No BOQ selected</h3><p>Upload a BOQ PDF to parse, review, and compare it with the catalog.</p><button className="btn btn-primary" onClick={() => setUploadOpen(true)}>Upload BOQ</button></div>
      ) : null}

      {boqLoadState === "loaded" && selected && selected.status !== "approved" ? (
        <div className="proto-card my-4 border-accent/25 bg-accent/5 p-5" data-od-id="compare-preparation">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-accent">Prepare before comparison</p>
              <h2 className="mt-1 font-heading text-lg font-medium">Resolve catalog lines while checking the source PDF</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Every priced line must be matched, created, or excluded with a reason before this BOQ can be approved and compared.</p>
            </div>
            <Link
              data-od-id="compare-review-match"
              href={boqComparisonReviewHref(selected.id)}
              className="btn btn-primary w-full sm:w-auto"
            >
              Review, match & approve
            </Link>
          </div>
          <div className="mt-4 flex items-center gap-3 text-sm">
            <strong className="font-mono text-base">{selectedReadiness?.resolved ?? 0}/{selectedReadiness?.total ?? 0}</strong>
            <span>catalog-ready lines</span>
            {(selectedReadiness?.blocking ?? 0) > 0 ? <span className="text-muted-foreground">· {selectedReadiness?.blocking} still need action</span> : <span className="text-[#006400]">· Ready to approve</span>}
          </div>
        </div>
      ) : null}

      {boqLoadState === "loaded" && selected && selected.status === "approved" && comparisonLoadState === "loading" ? (
        <div className="proto-loading-state compare-state" role="status">
          <div><span className="proto-spinner" aria-hidden="true" /> Comparing BOQ to catalog…</div>
        </div>
      ) : null}
      {boqLoadState === "loaded" && selected && selected.status === "approved" && comparisonLoadState === "error" ? (
        <div className="proto-empty-state proto-error-state compare-state" role="alert">
          <AlertCircle /><h3>Couldn&apos;t load this comparison</h3><p>Your BOQ has not been changed.</p>
          <button className="btn btn-secondary" onClick={() => void loadComparison(selectedId)}>Retry</button>
        </div>
      ) : null}
      {boqLoadState === "loaded" && selected && selected.status === "approved" && rows.length > 0 ? (
        <div className="compare-grid">
          <BoqCatalogComponentTable
            rows={rows}
            onMatch={setMatchTarget}
          />
        </div>
      ) : null}

      <UploadModal open={uploadOpen} onOpenChange={setUploadOpen} onUploadComplete={handleUploadComplete} />
      {matchTarget && selected ? (
        <CatalogMatchModal
          itemDesc={matchTarget.item.desc}
          itemUnit={matchTarget.item.unit}
          itemCode={matchTarget.item.code}
          sourceProject={selected.project}
          sourceVendor={selected.vendor}
          matchContext={{ boqId: selected.id, sectionIndex: matchTarget.sectionIndex, ...matchTarget.identity }}
          onClose={() => setMatchTarget(null)}
          onMatch={async () => {
            setMatchTarget(null)
            if (await loadComparison(selected.id)) {
              toast.success("Comparison refreshed")
            }
          }}
        />
      ) : null}
    </div>
  )
}
