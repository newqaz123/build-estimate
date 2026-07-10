"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Upload as UploadIcon, Search, ChevronLeft, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { UploadModal } from "@/components/upload-modal"
import { ReviewPanel } from "@/components/review-panel"
import type { Boq } from "@/lib/boq-schema"

const FILTERS = [
  "All",
  "Structural",
  "MEP",
  "Finishing",
  "Draft",
  "Active",
  "Review",
  "Approved",
  "Parsed",
] as const

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-[#666666]/12 text-[#666666]",
  parsed: "bg-[#666666]/12 text-[#666666]",
  active: "bg-accent/12 text-accent",
  review: "bg-[#eab308]/18 text-[#b88a00]",
  approved: "bg-[#006400]/12 text-[#006400]",
  rejected: "bg-[#dc2626]/12 text-[#dc2626]",
}

const STATUS_DOT: Record<string, string> = {
  draft: "bg-[#666666]",
  parsed: "bg-[#666666]",
  active: "bg-accent",
  review: "bg-[#eab308]",
  approved: "bg-[#006400]",
  rejected: "bg-[#dc2626]",
}

export default function BoqsPage() {
  const [boqs, setBoqs] = useState<Boq[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [activeFilter, setActiveFilter] = useState<string>("All")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [reviewBoq, setReviewBoq] = useState<Boq | null>(null)

  const fetchBoqs = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), limit: "10" })
      if (search) params.set("search", search)

      const f = activeFilter.toLowerCase()
      const statusFilters = ["draft", "parsed", "active", "review", "approved", "rejected"]
      const typeFilters = ["structural", "mep", "finishing"]
      if (statusFilters.includes(f)) params.set("status", f)
      else if (typeFilters.includes(f)) params.set("workType", f.charAt(0).toUpperCase() + f.slice(1))

      const res = await fetch(`/api/boqs?${params}`)
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      setBoqs(data.boqs || [])
      setTotal(data.total || 0)
      setTotalPages(data.totalPages || 1)
    } catch {
      toast.error("Failed to load BOQs")
    } finally {
      setLoading(false)
    }
  }, [page, search, activeFilter])

  useEffect(() => {
    fetchBoqs()
  }, [fetchBoqs])

  const handleUploadComplete = (boq: Boq) => {
    setReviewBoq(boq)
    fetchBoqs()
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
      <div data-od-id="page-heading" className="mb-4">
        <p className="text-sm text-muted-foreground">
          Upload, manage, and track all vendor BOQs across your projects.
        </p>
      </div>

      <div
        className="flex items-center justify-between mb-4 gap-4"
        data-od-id="toolbar"
      >
        <div className="flex items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search BOQs…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                data-filter={f.toLowerCase()}
                onClick={() => {
                  setActiveFilter(f)
                  setPage(1)
                }}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                  activeFilter === f
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <Button onClick={() => setUploadOpen(true)}>
          <UploadIcon className="w-4 h-4" />
          Upload BOQ
        </Button>
      </div>

      {loading && (
        <div
          className="flex items-center justify-center h-64 text-sm text-muted-foreground"
          data-od-id="loading-state"
        >
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
            Loading BOQs…
          </div>
        </div>
      )}

      {!loading && boqs.length === 0 && (
        <div
          className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground"
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
          <Button onClick={() => setUploadOpen(true)}>Upload BOQ</Button>
        </div>
      )}

      {!loading && boqs.length > 0 && (
        <>
          <div
            className="border border-border rounded-lg overflow-hidden"
            data-od-id="boq-table"
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left p-3 font-medium">Project</th>
                  <th className="text-left p-3 font-medium">Vendor</th>
                  <th className="text-left p-3 font-medium">Work Type</th>
                  <th className="text-left p-3 font-medium">Date</th>
                  <th className="text-right p-3 font-medium">Items</th>
                  <th className="text-right p-3 font-medium">Total</th>
                  <th className="text-left p-3 font-medium">Status</th>
                  <th className="text-left p-3 font-medium">Std</th>
                  <th className="text-left p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {boqs.map((boq) => {
                  const std = computeStdStats(boq)
                  return (
                    <tr
                      key={boq.id}
                      className="border-b border-border last:border-b-0 hover:bg-muted/30"
                      data-boq-id={boq.id}
                    >
                      <td className="p-3">
                        <Link
                          href={`/boqs/${boq.id}`}
                          className="text-sm font-medium text-foreground hover:text-accent no-underline"
                        >
                          {boq.project}
                        </Link>
                      </td>
                      <td className="p-3 text-muted-foreground">{boq.vendor}</td>
                      <td className="p-3">{boq.workType}</td>
                      <td className="p-3 text-muted-foreground">{boq.date}</td>
                      <td className="p-3 text-right font-mono text-xs">
                        {boq.totalItems}
                      </td>
                      <td className="p-3 text-right font-mono text-xs">
                        {formatCurrency(boq.grandTotal)}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full ${
                            STATUS_BADGE[boq.status] || STATUS_BADGE.draft
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              STATUS_DOT[boq.status] || STATUS_DOT.draft
                            }`}
                          />
                          {boq.status}
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {std.matched}/{std.total}
                          </span>
                          <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${std.pct}%`, backgroundColor: std.color }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="p-3">
                        <Link
                          href={`/boqs/${boq.id}`}
                          className="inline-flex items-center justify-center h-7 px-2.5 text-xs font-medium rounded-lg border border-transparent hover:bg-muted hover:text-foreground transition-colors"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div
            className="flex items-center justify-between mt-4 text-sm text-muted-foreground"
            data-od-id="pagination"
          >
            <span>
              Showing {Math.min((page - 1) * 10 + 1, total)}–{Math.min(page * 10, total)} of{" "}
              {total}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="w-3 h-3" />
              </Button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let p: number
                if (totalPages <= 7) {
                  p = i + 1
                } else if (page <= 4) {
                  p = i + 1
                } else if (page >= totalPages - 3) {
                  p = totalPages - 6 + i
                } else {
                  p = page - 3 + i
                }
                return (
                  <Button
                    key={p}
                    variant={p === page ? "default" : "outline"}
                    size="xs"
                    onClick={() => setPage(p)}
                    className="min-w-[28px]"
                  >
                    {p}
                  </Button>
                )
              })}
              <Button
                variant="outline"
                size="xs"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="w-3 h-3" />
              </Button>
            </div>
          </div>
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
          onApproved={() => fetchBoqs()}
        />
      )}
    </>
  )
}
