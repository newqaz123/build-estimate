"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CollapsibleSection } from "@/components/collapsible-section"
import { CatalogMatchModal } from "@/components/catalog-match-modal"
import { toast } from "sonner"
import { ChevronLeft, Search, Sparkles, Save, FileDown } from "lucide-react"
import { ProtoBadge } from "@/components/proto-badge"
import type { Boq, BoqItem } from "@/lib/boq-schema"

type EditsMap = Record<string, Record<string, string | number | undefined>>

const FILTERS = ["All", "Unit", "Lump Sum", "Job"] as const

function renderStdContent(
  item: BoqItem,
  onMatch: () => void,
  onAccept: () => void,
  onReject: () => void
) {
  const status = (item.stdStatus || 'unmatched') as string
  if (status === 'matched') {
    return (
      <div className="flex flex-col gap-0.5">
        <ProtoBadge status="matched" />
        {item.stdMatch && <span className="text-[11px] text-muted-foreground truncate max-w-[140px]">{item.stdMatch}</span>}
      </div>
    )
  }
  if (status === 'fuzzy' || status === 'llm') {
    const badgeStatus = status === 'fuzzy' ? 'fuzzy' : 'llm'
    return (
      <div className="flex flex-col gap-1">
        <ProtoBadge status={badgeStatus} />
        {item.stdMatch && <span className="text-[11px] text-foreground truncate max-w-[140px]">{item.stdMatch}</span>}
        <div className="flex gap-1">
          <button onClick={onAccept} className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground hover:bg-accent/80">Accept</button>
          <button onClick={onReject} className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted">×</button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <ProtoBadge status="unmatched" />
      <button onClick={onMatch} className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground">Match…</button>
    </div>
  )
}

export default function BoqDetailPage() {
  const params = useParams()
  const id = params.id as string

  const [boq, setBoq] = useState<Boq | null>(null)
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<EditsMap>({})
  const [activeFilter, setActiveFilter] = useState<string>("All")
  const [search, setSearch] = useState("")
  const [catalogMatchTarget, setCatalogMatchTarget] = useState<{
    si: number
    ii: number
    desc: string
    unit: string
  } | null>(null)

  const editingRef = useRef<string | null>(null)

  const fetchBoq = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/boqs/${id}`)
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      setBoq(data)
    } catch {
      toast.error("Failed to load BOQ")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchBoq()
  }, [fetchBoq])

  const handleEdit = (key: string, field: string, value: string | number | undefined) => {
    setEdits((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }))
  }

  const handleSaveAll = async () => {
    if (!boq) return
    const keys = Object.keys(edits)
    if (keys.length === 0) {
      toast.info("No changes to save")
      return
    }

    const updatedSections = boq.sections.map((section, si) => ({
      ...section,
      items: section.items.map((item, ii) => {
        const key = `${si}-${ii}`
        if (!edits[key]) return item
        const updated = { ...item, ...edits[key] }
        if (edits[key].qty !== undefined || edits[key].rate !== undefined) {
          updated.total = (updated.qty ?? item.qty) * (updated.rate ?? item.rate)
        }
        return updated
      }),
    }))

    try {
      const res = await fetch(`/api/boqs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: updatedSections }),
      })
      if (!res.ok) throw new Error("Failed to save")
      const updated = await res.json()
      setBoq(updated)
      setEdits({})
      toast.success("All changes saved")
    } catch {
      toast.error("Failed to save changes")
    }
  }

  const handleMetaEdit = async (field: string, value: string) => {
    if (!boq) return
    try {
      const res = await fetch(`/api/boqs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) throw new Error("Failed to update")
      const updated = await res.json()
      setBoq(updated)
      toast.success(`${field.charAt(0).toUpperCase() + field.slice(1)} updated`)
    } catch {
      toast.error("Failed to update")
    }
  }

  const handleApprove = async () => {
    if (!boq) return
    try {
      const res = await fetch(`/api/boqs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      })
      if (!res.ok) throw new Error("Failed to approve")
      const updated = await res.json()
      setBoq(updated)
      toast.success("BOQ approved")
    } catch {
      toast.error("Failed to approve")
    }
  }

  const handleStdAccept = (si: number, ii: number) => {
    if (!boq) return
    const key = `${si}-${ii}`
    handleEdit(key, "stdStatus", "matched")
    toast.success("Suggestion accepted")
  }

  const handleStdReject = (si: number, ii: number) => {
    if (!boq) return
    const key = `${si}-${ii}`
    handleEdit(key, "stdStatus", "unmatched")
    handleEdit(key, "stdMatch", undefined)
    toast.info("Suggestion dismissed")
  }

  const handleStdMatch = (si: number, ii: number) => {
    if (!boq) return
    const item = boq.sections[si].items[ii]
    const edited = edits[`${si}-${ii}`]
    setCatalogMatchTarget({
      si,
      ii,
      desc: (edited?.desc as string) || item.desc,
      unit: (edited?.unit as string) || item.unit,
    })
  }

  const handleCatalogMatch = (standardId: string, standardDesc: string) => {
    if (!catalogMatchTarget) return
    const key = `${catalogMatchTarget.si}-${catalogMatchTarget.ii}`
    handleEdit(key, "stdMatch", standardDesc)
    handleEdit(key, "stdStatus", "matched")
    setCatalogMatchTarget(null)
    toast.success(`Matched to: "${standardDesc}"`)
  }

  const handleLlmSuggest = async () => {
    if (!boq) return
    let count = 0
    boq.sections.forEach((section, si) => {
      section.items.forEach((item, ii) => {
        const key = `${si}-${ii}`
        const current = edits[key]
        const stdStatus = ((current?.stdStatus ?? item.stdStatus) || "") as string
        if (stdStatus === "unmatched" || stdStatus === "pending") {
          handleEdit(key, "stdStatus", "llm")
          handleEdit(key, "stdMatch", `${item.desc} (suggested)`)
          count++
        }
      })
    })
    if (count > 0) toast.success(`LLM suggestions applied to ${count} items`)
    else toast.info("No unmatched items to suggest")
  }

  const handleAcceptAll = () => {
    if (!boq) return
    let count = 0
    boq.sections.forEach((section, si) => {
      section.items.forEach((item, ii) => {
        const key = `${si}-${ii}`
        const current = edits[key]
        const stdStatus = ((current?.stdStatus ?? item.stdStatus) || "") as string
        if (stdStatus === "fuzzy" || stdStatus === "llm") {
          handleEdit(key, "stdStatus", "matched")
          count++
        }
      })
    })
    if (count > 0) toast.success(`Accepted ${count} suggestions`)
    else toast.info("No suggestions to accept")
  }

  const handleExportCsv = () => {
    if (!boq) return
    const rows = [["Section", "Code", "Description", "Unit", "Qty", "Rate", "Total", "Type", "Std Status", "Std Match"]]
    boq.sections.forEach((section) => {
      section.items.forEach((item) => {
        rows.push([
          section.header,
          item.code,
          item.desc,
          item.unit || "",
          String(item.qty ?? ""),
          String(item.rate ?? ""),
          String(item.total),
          item.type,
          item.stdStatus,
          item.stdMatch || "",
        ])
      })
    })
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${boq.project || "boq"}-detail.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success("CSV exported")
  }

  const handleDeleteItem = async (si: number, ii: number) => {
    if (!boq) return
    const updatedSections = boq.sections
      .map((section, sIdx) =>
        sIdx === si
          ? { ...section, items: section.items.filter((_, iIdx) => iIdx !== ii) }
          : section
      )
      .filter((section) => section.items.length > 0)
    try {
      const res = await fetch(`/api/boqs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: updatedSections }),
      })
      if (!res.ok) throw new Error("Failed to delete")
      const updated = await res.json()
      setBoq(updated)
      setEdits({})
      toast.success("Item removed")
    } catch {
      toast.error("Failed to remove item")
    }
  }

  const filteredSections = boq
    ? boq.sections
        .map((section, si) => ({
          realSi: si,
          header: section.header,
          items: section.items
            .map((item, ii) => ({ item, ii }))
            .filter(({ item, ii }) => {
              const edited = edits[`${si}-${ii}`] || {}
              const type = (edited.type as string) || item.type
              if (activeFilter !== "All") {
                const filterMap: Record<string, string> = { "Unit": "unit", "Lump Sum": "lump_sum", "Job": "job" }
                if (type !== filterMap[activeFilter]) return false
              }
              if (search) {
                const q = search.toLowerCase()
                const desc = (edited.desc as string) || item.desc
                const code = (edited.code as string) || item.code
                if (!desc.toLowerCase().includes(q) && !code.toLowerCase().includes(q)) return false
              }
              return true
            }),
        }))
        .filter((s) => s.items.length > 0)
    : []

  const grandTotal = boq
    ? boq.sections.reduce((s, sec) => s + sec.items.reduce((s2, i) => s2 + i.total, 0), 0)
    : 0

  const editsCount = Object.keys(edits).length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-muted-foreground" data-od-id="loading-state">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
          Loading BOQ…
        </div>
      </div>
    )
  }

  if (!boq) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground" data-od-id="error-state">
        <h3 className="text-sm font-medium">BOQ not found</h3>
        <Link href="/boqs" className="text-sm text-accent hover:underline">Back to BOQs</Link>
      </div>
    )
  }

  return (
    <div className="pb-16" data-od-id="boq-detail">
      <header className="flex items-center justify-between mb-5" data-od-id="topbar">
        <div className="flex items-center gap-3">
          <Link
            href="/boqs"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground no-underline"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">{boq.project}</h1>
          <ProtoBadge status={boq.status as any} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            <FileDown className="w-3.5 h-3.5" />
            Download PDF
          </Button>
          <Button variant="ghost" size="sm" onClick={handleExportCsv}>
            <FileDown className="w-3.5 h-3.5" />
            Export CSV
          </Button>
          {boq.status !== "approved" && (
            <Button size="sm" onClick={handleApprove}>
              Approve
            </Button>
          )}
        </div>
      </header>

      <div
        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-5"
        data-od-id="boq-meta"
      >
        {([
          { key: "vendor", label: "Vendor", value: boq.vendor, editable: true },
          { key: "workType", label: "Work Type", value: boq.workType, editable: true, type: "select", options: ["Structural", "MEP", "Finishing"] },
          { key: "date", label: "Date", value: boq.date, editable: true, type: "date" },
          { key: null, label: "Total Items", value: String(boq.totalItems), editable: false },
          { key: null, label: "Grand Total", value: `฿${grandTotal.toLocaleString()}`, editable: false },
          { key: null, label: "BOQ ID", value: boq.id.slice(0, 8), editable: false },
        ] as Array<{
          key: string | null
          label: string
          value: string
          editable: boolean
          type?: "text" | "select" | "date"
          options?: string[]
        }>).map((meta) => (
          <MetaField
            key={meta.label}
            label={meta.label}
            value={meta.value}
            editable={meta.editable}
            field={meta.key}
            onSave={handleMetaEdit}
            type={meta.type}
            options={meta.options}
          />
        ))}
      </div>

      <div className="flex items-center justify-between mb-4 gap-4" data-od-id="toolbar">
        <div className="flex items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                data-filter={f.toLowerCase().replace(/\s+/g, "_")}
                onClick={() => setActiveFilter(f)}
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
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="xs" onClick={handleLlmSuggest}>
            <Sparkles className="w-3 h-3" />
            LLM Suggest
          </Button>
          <Button variant="ghost" size="xs" onClick={handleAcceptAll}>
            Accept All
          </Button>
          {editsCount > 0 && (
            <Button size="xs" onClick={handleSaveAll}>
              <Save className="w-3 h-3" />
              Save all changes ({editsCount})
            </Button>
          )}
        </div>
      </div>

      <div data-od-id="boq-sections" className="space-y-3">
          {filteredSections.map((section) => {
          const si = section.realSi
          const sectionTotal = section.items.reduce((sum, { item }) => sum + (item.total ?? 0), 0)
          return (
            <CollapsibleSection
              key={si}
              title={section.header}
              subtitle={`${section.items.length} items · ฿${sectionTotal.toLocaleString()}`}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Code</th>
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Description</th>
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Unit</th>
                      <th className="text-right p-2.5 font-medium text-xs text-muted-foreground">Qty</th>
                      <th className="text-right p-2.5 font-medium text-xs text-muted-foreground">Rate</th>
                      <th className="text-right p-2.5 font-medium text-xs text-muted-foreground">Total</th>
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Type</th>
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Std</th>
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.items.map(({ item, ii }) => {
                      const key = `${si}-${ii}`
                      const edited = edits[key] || {}
                      const display = { ...item, ...edited }
                      const hasEdits = key in edits
                      const isEditing = editingRef.current === key

                      return (
                        <tr
                          key={`${display.code}-${ii}`}
                          data-item-id={key}
                          className={`group border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors ${
                            hasEdits ? "bg-[#eab308]/6" : ""
                          } ${isEditing ? "bg-accent/6" : ""}`}
                        >
                          <td className="p-2.5">
                            {isEditing ? (
                              <Input
                                defaultValue={display.code}
                                className="h-7 w-20 font-mono text-xs"
                                onBlur={(e) => handleEdit(key, "code", e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                              />
                            ) : (
                              <span className="font-mono text-xs">{display.code || "—"}</span>
                            )}
                          </td>
                          <td className="p-2.5 max-w-[240px]">
                            {isEditing ? (
                              <Input
                                defaultValue={display.desc}
                                className="h-7 text-xs"
                                onBlur={(e) => handleEdit(key, "desc", e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                              />
                            ) : (
                              <span className="text-xs">{display.desc}</span>
                            )}
                          </td>
                          <td className="p-2.5">
                            {isEditing ? (
                              <Input
                                defaultValue={display.unit || ""}
                                className="h-7 w-16 text-xs"
                                onBlur={(e) => handleEdit(key, "unit", e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                              />
                            ) : (
                              <span className="text-xs">{display.unit || "—"}</span>
                            )}
                          </td>
                          <td className="p-2.5 text-right font-mono text-xs">
                            {isEditing ? (
                              <Input
                                type="number"
                                defaultValue={display.qty ?? ""}
                                className="h-7 w-20 text-xs text-right"
                                onBlur={(e) => handleEdit(key, "qty", parseFloat(e.target.value) || 0)}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                              />
                            ) : (
                              <span>{display.qty != null ? display.qty.toLocaleString() : "—"}</span>
                            )}
                          </td>
                          <td className="p-2.5 text-right font-mono text-xs">
                            {isEditing ? (
                              <Input
                                type="number"
                                defaultValue={display.rate ?? ""}
                                className="h-7 w-24 text-xs text-right"
                                onBlur={(e) => handleEdit(key, "rate", parseFloat(e.target.value) || 0)}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                              />
                            ) : (
                              <span>{display.rate != null ? `฿${display.rate.toLocaleString()}` : "—"}</span>
                            )}
                          </td>
                          <td className="p-2.5 text-right font-mono text-xs">
                            ฿{(display.qty ?? 0) * (display.rate ?? 0) > 0
                              ? ((display.qty ?? 0) * (display.rate ?? 0)).toLocaleString()
                              : display.total.toLocaleString()}
                          </td>
                          <td className="p-2.5">
                            {isEditing ? (
                              <select
                                defaultValue={display.type}
                                className="h-7 text-xs rounded-lg border border-input bg-transparent px-2"
                                onChange={(e) => handleEdit(key, "type", e.target.value)}
                              >
                                <option value="unit">Unit</option>
                                <option value="lump_sum">L/S</option>
                                <option value="job">Job</option>
                              </select>
                            ) : (
                              <span className="text-xs">
                                {display.type === "lump_sum" ? (
                                  <span className="inline-flex text-xs font-medium px-2 py-0.5 rounded-full bg-[#666666]/10 text-[#666666]">L/S</span>
                                ) : display.type === "job" ? (
                                  <span className="inline-flex text-xs font-medium px-2 py-0.5 rounded-full bg-[#666666]/10 text-[#666666]">Job</span>
                                ) : (
                                  "—"
                                )}
                              </span>
                            )}
                          </td>
                          <td className="p-2.5">
                            {renderStdContent(
                              display as BoqItem,
                              () => handleStdMatch(si, ii),
                              () => handleStdAccept(si, ii),
                              () => handleStdReject(si, ii)
                            )}
                          </td>
                          <td className="p-2.5">
                            {isEditing ? (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => {
                                    editingRef.current = null
                                    setEdits({ ...edits })
                                  }}
                                  className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground"
                                >
                                  Done
                                </button>
                                <button
                                  onClick={() => {
                                    if (confirm('Remove this item from the BOQ?')) {
                                      handleDeleteItem(si, ii)
                                    }
                                  }}
                                  className="text-xs px-2 py-1 rounded text-destructive hover:bg-destructive/10"
                                >
                                  Delete
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                {hasEdits && (
                                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                                      <circle cx="8" cy="8" r="6.5" /><polyline points="8 4 8 8 11 11" />
                                    </svg>
                                    Unsaved
                                  </span>
                                )}
                                <button
                                  onClick={() => {
                                    editingRef.current = key
                                    setEdits({ ...edits })
                                  }}
                                  className="text-xs text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                  Edit
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CollapsibleSection>
          )
        })}
        {filteredSections.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-sm text-muted-foreground" data-od-id="empty-state">
            <p>No items match your filter</p>
          </div>
        )}
      </div>

      <div
        className="mt-3 text-xs text-muted-foreground flex items-center gap-2"
        data-od-id="edit-history"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
          <circle cx="8" cy="8" r="6.5" />
          <polyline points="8 4 8 8 11 11" />
        </svg>
        <span>
          {editsCount > 0
            ? `${editsCount} item${editsCount > 1 ? "s" : ""} with unsaved changes`
            : "All changes saved"}
        </span>
      </div>

      <div
        className="fixed bottom-0 left-[240px] right-0 border-t border-border bg-background/95 backdrop-blur-sm px-6 py-3 flex items-center justify-between z-40"
        style={{ boxShadow: "0 -4px 12px rgba(4, 14, 32, 0.06)" }}
        data-od-id="summary-bar"
      >
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {boq.totalItems} item{boq.totalItems !== 1 ? "s" : ""}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="font-semibold text-base">
            Grand Total: ฿{grandTotal.toLocaleString()}
          </span>
        </div>
        <Button>
          Add to Estimate
        </Button>
      </div>

      {catalogMatchTarget && (
        <CatalogMatchModal
          itemDesc={catalogMatchTarget.desc}
          itemUnit={catalogMatchTarget.unit}
          onMatch={handleCatalogMatch}
          onClose={() => setCatalogMatchTarget(null)}
        />
      )}
    </div>
  )
}

function MetaField({
  label,
  value,
  editable,
  field,
  onSave,
  type = "text",
  options,
}: {
  label: string
  value: string
  editable: boolean
  field: string | null
  onSave: (field: string, value: string) => void
  type?: "text" | "select" | "date"
  options?: string[]
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const handleSave = () => {
    if (field && draft !== value) {
      onSave(field, draft)
    }
    setEditing(false)
  }

  return (
    <div className="p-3 border border-border rounded-lg" data-meta={field || undefined}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
          {label}
        </span>
        {editable && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        type === "select" ? (
          <select
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleSave}
            className="h-7 text-sm mt-0.5 rounded-lg border border-input bg-transparent px-2"
            autoFocus
          >
            {options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <Input
            type={type === "date" ? "date" : "text"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleSave}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave()
              if (e.key === "Escape") setEditing(false)
            }}
            className="h-7 text-sm mt-0.5"
            autoFocus
          />
        )
      ) : (
        <div className="text-sm font-medium">{value}</div>
      )}
    </div>
  )
}
