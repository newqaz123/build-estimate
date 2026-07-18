"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import Link from "next/link"
import { Eye, Trash2, Upload as UploadIcon } from "lucide-react"
import { toast } from "sonner"
import { UploadModal } from "@/components/upload-modal"
import { ReviewPanel } from "@/components/review-panel"
import type { Boq } from "@/lib/boq-schema"
import { ProtoBadge } from "@/components/proto-badge"
import { ProtoFilterChip } from "@/components/proto-filter-chip"
import { ProtoDataTable } from "@/components/proto-data-table"
import { ProtoPagination } from "@/components/proto-pagination"
import { buildBoqCsv } from "@/lib/boq-csv"

const typeFilters = ["All", "Structural", "MEP", "Finishing"] as const
const statusFilters = ["Draft", "Active", "Review", "Approved", "Parsed"] as const

function exportBoqCsv(boq: Boq): void {
  const csv = buildBoqCsv(boq)
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${boq.project.replace(/\s+/g, "-")}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function BoqsPage() {
  const [boqs, setBoqs] = useState<Boq[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [search, setSearch] = useState("")
  const [activeFilter, setActiveFilter] = useState<string>("All")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [reviewBoq, setReviewBoq] = useState<Boq | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)

  const fetchBoqs = useCallback(async () => {
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    setLoading(true)
    setLoadError(false)
    try {
      const params = new URLSearchParams({ page: String(page), limit: "10" })
      if (search) params.set("search", search)

      const f = activeFilter.toLowerCase()
      const statusFilters = ["draft", "parsed", "active", "review", "approved", "rejected"]
      const typeFilters = ["structural", "mep", "finishing"]
      if (statusFilters.includes(f)) params.set("status", f)
      else if (typeFilters.includes(f)) params.set("workType", f.charAt(0).toUpperCase() + f.slice(1))

      const res = await fetch(`/api/boqs?${params}`, { signal: controller.signal })
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      setBoqs(data.boqs || [])
      setTotal(data.total || 0)
      setTotalPages(data.totalPages || 1)
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return
      setBoqs([])
      setLoadError(true)
      toast.error("Failed to load BOQs")
    } finally {
      if (controller === requestControllerRef.current) {
        requestControllerRef.current = null
        setLoading(false)
      }
    }
  }, [page, search, activeFilter])

  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => {
      if (active) void fetchBoqs()
    })
    return () => {
      active = false
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
    }
  }, [fetchBoqs])

  const handleUploadComplete = (boq: Boq) => {
    setReviewBoq(boq)
    fetchBoqs()
  }

  const handleDeleteBoq = async (boq: Boq) => {
    const confirmation = window.prompt(
      `Delete the entire BOQ “${boq.project}” and its source PDF?\n\nType the project name to confirm.`,
    )
    if (confirmation !== boq.project) return
    const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, { method: "DELETE" })
    if (!response.ok) {
      toast.error("The BOQ could not be deleted")
      return
    }
    toast.success("BOQ deleted")
    void fetchBoqs()
  }

  const formatCurrency = (amount: number) => {
    if (amount >= 1_000_000) return `฿${(amount / 1_000_000).toFixed(1)}M`
    if (amount >= 1_000) return `฿${(amount / 1_000).toFixed(1)}K`
    return `฿${amount.toLocaleString()}`
  }

  const computeStdStats = (boq: Boq) => {
    const allItems = boq.sections.flatMap((s) => s.items)
    const matched = allItems.filter((i) => i.stdStatus === "matched").length
    const pct = boq.totalItems > 0 ? Math.round((matched / boq.totalItems) * 100) : 0
    const color = pct >= 90 ? "#006400" : pct >= 60 ? "var(--accent)" : "#eab308"
    return { matched, total: boq.totalItems, pct, color }
  }

  return (
    <>
      <div data-od-id="page-heading" className="mb-6">
        <p className="text-sm text-muted-foreground">
          Upload, manage, and track all vendor BOQs across your projects.
        </p>
      </div>

      <div
        className="proto-toolbar"
        data-od-id="toolbar"
      >
        <div className="proto-toolbar-left">
          <div className="search-wrap">
            <label htmlFor="boqSearch" className="sr-only">Search BOQs</label>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              id="boqSearch"
              className="proto-input"
              type="text"
              placeholder="Search BOQs…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
            />
          </div>
          <div className="filter-group" aria-label="Filter BOQs">
            {typeFilters.map(f => (
              <ProtoFilterChip key={f} active={activeFilter === f} label={f} onClick={() => { setActiveFilter(f); setPage(1) }} />
            ))}
            <span className="w-px h-5 bg-border mx-1" />
            {statusFilters.map(f => (
              <ProtoFilterChip key={f} active={activeFilter === f} label={f} onClick={() => { setActiveFilter(f); setPage(1) }} />
            ))}
          </div>
        </div>
        <div className="proto-toolbar-right">
          <button type="button" onClick={() => setUploadOpen(true)} className="btn btn-primary btn-sm">
            <UploadIcon className="w-4 h-4" />
            Upload BOQ
          </button>
        </div>
      </div>

      {loading && (
        <div
          className="proto-loading-state"
          data-od-id="loading-state"
        >
          <div className="flex items-center gap-2">
            <div className="proto-spinner" />
            Loading BOQs…
          </div>
        </div>
      )}

      {!loading && loadError && (
        <div className="proto-empty-state proto-error-state" role="alert" data-od-id="error-state">
          <h3>Couldn’t load BOQs</h3>
          <p>Check your connection, then try loading the list again.</p>
          <button type="button" className="btn btn-secondary" onClick={() => void fetchBoqs()}>Retry</button>
        </div>
      )}

      {!loading && !loadError && boqs.length === 0 && (
        <div
          className="proto-empty-state"
          data-od-id="empty-state"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            className="w-10 h-10 opacity-40"
          >
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <h3 className="text-sm font-medium">No BOQs yet</h3>
          <p className="text-sm">Upload your first Bill of Quantities PDF to get started.</p>
          <button type="button" onClick={() => setUploadOpen(true)} className="btn btn-primary">Upload BOQ</button>
        </div>
      )}

      {!loading && !loadError && boqs.length > 0 && (
        <>
          <ProtoDataTable
            headers={[
              { label: 'Project' },
              { label: 'Vendor' },
              { label: 'Work Type' },
              { label: 'Date' },
              { label: 'Items', className: 'num-col' },
              { label: 'Total', className: 'num-col' },
              { label: 'Status ⓘ', tooltip: 'Draft: Not yet finalised · Parsed: Docling extracted items, awaiting review · Active: In use on projects · Review: Under verification · Approved: Finalised and locked' },
              { label: 'Std ⓘ', tooltip: 'Standardization status: matched (auto or approved) vs unmatched items' },
              { label: 'Actions', className: 'text-right whitespace-nowrap' },
            ]}
            footer={
              <ProtoPagination page={page} totalPages={totalPages} total={total} limit={10} onPageChange={setPage} />
            }
            ariaLabel="Bills of Quantities"
            dataOdId="boq-table"
          >
            {boqs.map(boq => {
              const std = computeStdStats(boq)
              return (
                <tr key={boq.id} data-boq-id={boq.id}>
                  <td className="boq-name-cell"><Link href={`/boqs/${boq.id}`} className="boq-cell-truncate font-medium text-foreground hover:text-accent no-underline" title={boq.project}>{boq.project}</Link></td>
                  <td className="boq-name-cell text-muted-foreground"><span className="boq-cell-truncate" title={boq.vendor}>{boq.vendor}</span></td>
                  <td>{boq.workType}</td>
                  <td className="text-muted-foreground">{boq.date}</td>
                  <td className="num-col">{boq.totalItems}</td>
                  <td className="num-col">{formatCurrency(boq.grandTotal)}</td>
                  <td><ProtoBadge status={boq.status} /></td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: std.color }} />
                      <span className="text-xs text-muted-foreground">{std.matched}/{std.total}</span>
                      <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${std.pct}%`, backgroundColor: std.color }} />
                      </div>
                    </div>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {boq.status !== "approved" && boq.sourceAvailable ? (
                      <button type="button" onClick={() => setReviewBoq(boq)} className="btn btn-ghost btn-xs">
                        <Eye className="w-3.5 h-3.5" /> Review
                      </button>
                    ) : null}
                    <Link href={`/boqs/${boq.id}`} className="btn btn-ghost btn-xs">View</Link>
                    <button
                      onClick={() => exportBoqCsv(boq)}
                      className="btn btn-ghost btn-xs"
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteBoq(boq)}
                      className="btn btn-ghost btn-xs text-destructive"
                      aria-label={`Delete ${boq.project}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </ProtoDataTable>
        </>
      )}

      <UploadModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploadComplete={handleUploadComplete}
      />

      {reviewBoq && (
        <ReviewPanel
          boq={reviewBoq}
          onClose={() => setReviewBoq(null)}
          onApproved={() => { void fetchBoqs() }}
        />
      )}
    </>
  )
}
