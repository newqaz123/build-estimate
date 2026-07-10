"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Upload as UploadIcon, Search } from "lucide-react"
import { toast } from "sonner"
import { UploadModal } from "@/components/upload-modal"
import { ReviewPanel } from "@/components/review-panel"
import type { Boq } from "@/lib/boq-schema"
import { ProtoBadge } from "@/components/proto-badge"
import { ProtoFilterChip } from "@/components/proto-filter-chip"
import { ProtoDataTable } from "@/components/proto-data-table"
import { ProtoPagination } from "@/components/proto-pagination"

const typeFilters = ["All", "Structural", "MEP", "Finishing"] as const
const statusFilters = ["Draft", "Active", "Review", "Approved", "Parsed"] as const

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
          <div className="flex items-center gap-2 flex-wrap">
            {typeFilters.map(f => (
              <ProtoFilterChip key={f} active={activeFilter === f} label={f} onClick={() => { setActiveFilter(f); setPage(1) }} />
            ))}
            <span className="w-px h-5 bg-border mx-1" />
            {statusFilters.map(f => (
              <ProtoFilterChip key={f} active={activeFilter === f} label={f} onClick={() => { setActiveFilter(f); setPage(1) }} />
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
          <ProtoDataTable
            headers={[
              { label: 'Project' },
              { label: 'Vendor' },
              { label: 'Work Type' },
              { label: 'Date' },
              { label: 'Items', className: 'num-col' },
              { label: 'Total', className: 'num-col' },
              { label: 'Status' },
              { label: 'Std', tooltip: 'Standardization status: matched (auto or approved) vs unmatched items' },
              { label: 'Actions', className: 'text-right whitespace-nowrap' },
            ]}
          >
            {boqs.map(boq => {
              const std = computeStdStats(boq)
              return (
                <tr key={boq.id} data-boq-id={boq.id}>
                  <td><Link href={`/boqs/${boq.id}`} className="font-medium text-foreground hover:text-accent no-underline">{boq.project}</Link></td>
                  <td className="text-muted-foreground">{boq.vendor}</td>
                  <td>{boq.workType}</td>
                  <td className="text-muted-foreground">{boq.date}</td>
                  <td className="num-col">{boq.totalItems}</td>
                  <td className="num-col">{formatCurrency(boq.grandTotal)}</td>
                  <td><ProtoBadge status={boq.status as any} /></td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{std.matched}/{std.total}</span>
                      <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${std.pct}%`, backgroundColor: std.color }} />
                      </div>
                    </div>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <Link href={`/boqs/${boq.id}`} className="inline-flex items-center justify-center h-7 px-2.5 text-xs font-medium rounded-lg border border-transparent hover:bg-muted hover:text-foreground transition-colors">View</Link>
                  </td>
                </tr>
              )
            })}
          </ProtoDataTable>

          <ProtoPagination page={page} totalPages={totalPages} total={total} limit={10} onPageChange={setPage} />
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
