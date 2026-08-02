"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, ArrowLeftRight, Upload } from "lucide-react"
import { toast } from "sonner"

import { BoqCatalogComponentTable, summarizeComponentComparison } from "@/components/boq-catalog-component-table"
import { CatalogMatchModal } from "@/components/catalog-match-modal"
import { ProtoBadge } from "@/components/proto-badge"
import { ReviewPanel } from "@/components/review-panel"
import { UploadModal } from "@/components/upload-modal"
import type { Boq } from "@/lib/boq-schema"
import type { BoqCatalogComparisonRow } from "@/lib/boq-catalog-comparison"
import { getBoqCatalogReadiness } from "@/lib/boq-catalog-readiness"

type ComparisonResponse = { boqId: string; rows: BoqCatalogComparisonRow[] }

function currency(value: number) {
  return `฿${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatVariance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(1)}%`
}

export default function ComparePage() {
  const [boqs, setBoqs] = useState<Boq[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [reviewBoq, setReviewBoq] = useState<Boq | null>(null)
  const [matchTarget, setMatchTarget] = useState<BoqCatalogComparisonRow | null>(null)

  const loadBoqs = useCallback(async (preferredId?: string) => {
    const response = await fetch("/api/boqs?limit=1000")
    if (!response.ok) throw new Error("BOQs could not be loaded")
    const data = await response.json() as { boqs?: Boq[] }
    const next = data.boqs ?? []
    setBoqs(next)
    setSelectedId((current) => preferredId && next.some((boq) => boq.id === preferredId)
      ? preferredId
      : current && next.some((boq) => boq.id === current) ? current : next[0]?.id ?? "")
    setLoading(false)
  }, [])

  const loadComparison = useCallback(async (boqId: string) => {
    if (!boqId) { setComparison(null); return }
    setLoading(true)
    setLoadError(false)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boqId)}/comparison`)
      if (!response.ok) throw new Error("Comparison could not be loaded")
      setComparison(await response.json() as ComparisonResponse)
    } catch {
      setComparison(null)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => loadBoqs()).catch(() => { setLoadError(true); setLoading(false) })
  }, [loadBoqs])

  const selected = boqs.find((boq) => boq.id === selectedId)
  useEffect(() => {
    if (!selectedId || !selected) return
    if (selected.status !== "approved") return
    void Promise.resolve().then(() => loadComparison(selectedId))
  }, [loadComparison, selected, selectedId])

  const rows = comparison?.rows ?? []
  const comparisonSummary = summarizeComponentComparison(rows, selected?.grandTotal ?? 0)
  const selectedReadiness = selected ? getBoqCatalogReadiness(selected) : null

  const handleUploadComplete = (boq: Boq) => {
    setUploadOpen(false)
    setReviewBoq(boq)
    void loadBoqs(boq.id)
  }

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
          <select id="compare-boq" className="input compare-baseline-select" value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setComparison(null); setLoadError(false); setLoading(false) }}>
            {boqs.map((boq) => <option key={boq.id} value={boq.id}>{boq.project} — {boq.vendor}</option>)}
          </select>
          {selected ? <ProtoBadge status={selected.status} /> : null}
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setUploadOpen(true)}><Upload className="w-4 h-4" /> Upload BOQ to compare</button>
      </div>

      {loading ? <div className="proto-loading-state compare-state"><div><span className="proto-spinner" /> Comparing BOQ to catalog…</div></div> : null}
      {!loading && loadError ? (
        <div className="proto-empty-state proto-error-state compare-state" role="alert">
          <AlertCircle /><h3>Couldn&apos;t load this comparison</h3><p>Your BOQ has not been changed.</p>
          <button className="btn btn-secondary" onClick={() => void loadComparison(selectedId)}>Retry</button>
        </div>
      ) : null}
      {!loading && !loadError && boqs.length === 0 ? (
        <div className="proto-empty-state compare-state"><ArrowLeftRight /><h3>No BOQ selected</h3><p>Upload a BOQ PDF to parse, review, and compare it with the catalog.</p><button className="btn btn-primary" onClick={() => setUploadOpen(true)}>Upload BOQ</button></div>
      ) : null}

      {!loading && !loadError && selected && selected.status !== "approved" ? (
        <div className="proto-card my-4 border-accent/25 bg-accent/5 p-5" data-od-id="compare-preparation">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.08em] text-accent">Prepare before comparison</p>
              <h2 className="mt-1 font-heading text-lg font-medium">Resolve catalog lines while checking the source PDF</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Every priced line must be matched, created, or excluded with a reason before this BOQ can be approved and compared.</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => setReviewBoq(selected)} data-od-id="compare-review-match">
              Review, match & approve
            </button>
          </div>
          <div className="mt-4 flex items-center gap-3 text-sm">
            <strong className="font-mono text-base">{selectedReadiness?.resolved ?? 0}/{selectedReadiness?.total ?? 0}</strong>
            <span>catalog-ready lines</span>
            {(selectedReadiness?.blocking ?? 0) > 0 ? <span className="text-muted-foreground">· {selectedReadiness?.blocking} still need action</span> : <span className="text-[#006400]">· Ready to approve</span>}
          </div>
        </div>
      ) : null}

      {!loading && !loadError && rows.length > 0 ? (
        <div className="compare-grid">
          <BoqCatalogComponentTable
            rows={rows}
            onMatch={setMatchTarget}
          />
        </div>
      ) : null}

      <UploadModal open={uploadOpen} onOpenChange={setUploadOpen} onUploadComplete={handleUploadComplete} />
      {reviewBoq ? <ReviewPanel boq={reviewBoq} onClose={() => setReviewBoq(null)} primaryActionLabel="Approve & Compare" requireCatalogReadiness onApproved={(updated) => { setReviewBoq(null); void loadBoqs(updated.id); setSelectedId(updated.id) }} /> : null}
      {matchTarget && selected ? (
        <CatalogMatchModal
          itemDesc={matchTarget.item.desc}
          itemUnit={matchTarget.item.unit}
          itemCode={matchTarget.item.code}
          sourceProject={selected.project}
          sourceVendor={selected.vendor}
          matchContext={{ boqId: selected.id, sectionIndex: matchTarget.sectionIndex, ...matchTarget.identity }}
          onClose={() => setMatchTarget(null)}
          onMatch={async () => { setMatchTarget(null); await loadComparison(selected.id); toast.success("Comparison refreshed") }}
        />
      ) : null}
    </div>
  )
}
