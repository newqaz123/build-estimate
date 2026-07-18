"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { Input } from "@/components/ui/input"
import { CollapsibleSection } from "@/components/collapsible-section"
import { CatalogMatchModal } from "@/components/catalog-match-modal"
import { ReviewPanel } from "@/components/review-panel"
import { toast } from "sonner"
import { AlertCircle, ChevronLeft, Search, Sparkles, Save, FileDown, Loader2, Lock, Eye, Trash2 } from "lucide-react"
import { ProtoBadge } from "@/components/proto-badge"
import type { Boq, BoqItem } from "@/lib/boq-schema"
import { getBoqItemIdentityKey, getBoqItemRequestIdentity } from "@/lib/boq-item-identity"
import { applyManualCostAllocation, deriveSourceCostAllocation } from "@/lib/boq-cost-allocation"

type EditsMap = Record<string, Record<string, string | number | undefined>>
type LoadState = "loading" | "loaded" | "not-found" | "error"

const FILTERS = ["All", "Unit", "Lump Sum", "Job"] as const

function mergeItemEdits(item: BoqItem, edited: EditsMap[string] = {}): BoqItem {
  let merged = { ...item, ...edited } as BoqItem
  if (edited.materialCost !== undefined || edited.labourCost !== undefined) {
    const allocation = deriveSourceCostAllocation(item)
    merged = applyManualCostAllocation(
      merged,
      Number(edited.materialCost ?? allocation?.material ?? 0),
      Number(edited.labourCost ?? allocation?.labour ?? 0),
    )
  }
  if (edited.qty !== undefined || edited.rate !== undefined) {
    merged.total = (merged.qty ?? 0) * (merged.rate ?? 0)
  }
  return merged
}

function reindexEditsAfterDelete(edits: EditsMap, sectionIndex: number, itemIndex: number, sectionRemoved: boolean) {
  const next: EditsMap = {}
  for (const [key, value] of Object.entries(edits)) {
    const [si, ii] = key.split("-").map(Number)
    if (si === sectionIndex && ii === itemIndex) continue
    if (sectionRemoved && si > sectionIndex) next[`${si - 1}-${ii}`] = value
    else if (!sectionRemoved && si === sectionIndex && ii > itemIndex) next[`${si}-${ii - 1}`] = value
    else next[key] = value
  }
  return next
}

function StdContent({
  item,
  onMatch,
  onAccept,
  onReject,
  disabled,
}: {
  item: BoqItem
  onMatch: () => void
  onAccept: () => void
  onReject: () => void
  disabled: boolean
}) {
  const status = item.stdStatus === 'matched' && !item.stdId
    ? 'unmatched'
    : (item.stdStatus || 'unmatched') as string
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
          <button onClick={onAccept} disabled={disabled} className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground hover:bg-accent/80 disabled:opacity-50">Accept</button>
          <button onClick={onReject} disabled={disabled} aria-label="Reject suggestion" className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50">×</button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <ProtoBadge status="unmatched" />
      <button onClick={onMatch} disabled={disabled} className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50">Match…</button>
    </div>
  )
}

export default function BoqDetailPage() {
  const params = useParams()
  const id = params.id as string

  const [boq, setBoq] = useState<Boq | null>(null)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [edits, setEdits] = useState<EditsMap>({})
  const editsRef = useRef<EditsMap>({})
  const fetchControllerRef = useRef<AbortController | null>(null)
  const routeGenerationRef = useRef(0)
  const [activeFilter, setActiveFilter] = useState<string>("All")
  const [search, setSearch] = useState("")
  const [catalogMatchTarget, setCatalogMatchTarget] = useState<{
    si: number
    ii: number
    itemId?: string
    itemCode?: string
    desc: string
    unit: string
  } | null>(null)

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [matching, setMatching] = useState(false)
  const [deletingItem, setDeletingItem] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [updatingMeta, setUpdatingMeta] = useState<string | null>(null)
  const mutationBusy = saving || approving || matching || deletingItem !== null || updatingMeta !== null

  const replaceEdits = useCallback((next: EditsMap) => {
    editsRef.current = next
    setEdits(next)
  }, [])

  const fetchBoq = useCallback(async () => {
    fetchControllerRef.current?.abort()
    const controller = new AbortController()
    fetchControllerRef.current = controller
    const { signal } = controller
    setLoadState("loading")
    try {
      const res = await fetch(`/api/boqs/${id}`, { signal })
      if (signal.aborted || fetchControllerRef.current !== controller) return
      if (res.status === 404) {
        setBoq(null)
        setLoadState("not-found")
        return
      }
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      if (signal.aborted || fetchControllerRef.current !== controller) return
      setBoq(data)
      setLoadState("loaded")
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return
      setBoq(null)
      setLoadState("error")
    }
  }, [id])

  useEffect(() => {
    const generation = ++routeGenerationRef.current
    let disposed = false
    void Promise.resolve().then(() => {
      if (disposed) return
      replaceEdits({})
      setEditingKey(null)
      setCatalogMatchTarget(null)
      setSaving(false)
      setApproving(false)
      setDeletingItem(null)
      setUpdatingMeta(null)
      return fetchBoq()
    })
    return () => {
      disposed = true
      fetchControllerRef.current?.abort()
      if (routeGenerationRef.current === generation) routeGenerationRef.current += 1
    }
  }, [fetchBoq, replaceEdits])

  const handleEdit = (key: string, field: string, value: string | number | undefined) => {
    if (!boq || mutationBusy) return
    if (boq.status === "approved" && field !== "stdStatus" && field !== "stdMatch") return
    const current = editsRef.current
    replaceEdits({ ...current, [key]: { ...current[key], [field]: value } })
  }

  const handleSaveAll = async () => {
    if (!boq || boq.status === "approved" || mutationBusy) return
    const editSnapshot = editsRef.current
    const keys = Object.keys(editSnapshot)
    if (keys.length === 0) {
      toast.info("No changes to save")
      return
    }

    const updates = new Map<number, { sectionIndex: number; items: Array<Record<string, string | number | undefined>> }>()
    const linkedCanonicalEdits: Array<{ item: BoqItem; standardId: string; description?: string; unit?: string }> = []

    for (const key of keys) {
      const [sectionIndex, itemIndex] = key.split("-").map(Number)
      const item = boq.sections[sectionIndex]?.items[itemIndex]
      const edit = editSnapshot[key]
      if (!item || !edit) continue

      const sectionUpdates = updates.get(sectionIndex) ?? { sectionIndex, items: [] }
      const itemUpdate = { ...getBoqItemRequestIdentity(item), ...edit }
      sectionUpdates.items.push(itemUpdate)
      updates.set(sectionIndex, sectionUpdates)

      if (item.stdId && ((edit.desc !== undefined && edit.desc !== item.desc) || (edit.unit !== undefined && edit.unit !== item.unit))) {
        linkedCanonicalEdits.push({
          item,
          standardId: item.stdId,
          description: typeof edit.desc === "string" ? edit.desc : undefined,
          unit: typeof edit.unit === "string" ? edit.unit : undefined,
        })
      }
    }

    if (linkedCanonicalEdits.length > 0) {
      const standardIds = Array.from(new Set(linkedCanonicalEdits.map(({ standardId }) => standardId)))
      const impacts = await Promise.all(standardIds.map(async (standardId) => {
        try {
          const response = await fetch(`/api/boqs/${id}/items?stdId=${encodeURIComponent(standardId)}`)
          if (!response.ok) return { standardId }
          const data = await response.json() as {
            standard?: { description?: string }
            affectedLinkCount?: number
            affectedBoqCount?: number
          }
          return {
            standardId,
            description: data.standard?.description,
            affectedLinkCount: data.affectedLinkCount,
            affectedBoqCount: data.affectedBoqCount,
          }
        } catch {
          return { standardId }
        }
      }))
      const impactByStandardId = new Map(impacts.map((impact) => [impact.standardId, impact]))

      const impactLines = linkedCanonicalEdits.map(({ item, standardId }) => {
        const impact = impactByStandardId.get(standardId)
        const knownImpact = typeof impact?.affectedLinkCount === "number"
          ? `${impact.affectedLinkCount} affected linked BOQ row${impact.affectedLinkCount === 1 ? "" : "s"}${typeof impact.affectedBoqCount === "number" ? ` across ${impact.affectedBoqCount} BOQ${impact.affectedBoqCount === 1 ? "" : "s"}` : ""}`
          : "affected-link count unavailable; this row is linked"
        return `• ${impact?.description || item.stdMatch || item.desc}: ${knownImpact}`
      })
      const confirmed = window.confirm(
        `This edit changes a shared catalog item and will update its canonical description/unit on every linked BOQ row. Quantities, rates, and source provenance stay unchanged.\n\nKnown impact:\n${impactLines.join("\n")}\n\nContinue?`,
      )
      if (!confirmed) return
    }

    const generation = routeGenerationRef.current
    setSaving(true)
    try {
      const res = await fetch(`/api/boqs/${id}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: Array.from(updates.values()) }),
      })
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(errorBody?.error || "Failed to save")
      }
      const data = await res.json() as { boq?: Boq; sync?: { affectedItems?: number; affectedLinkCount?: number } } & Boq
      const updated = data.boq ?? data
      if (generation !== routeGenerationRef.current) return
      setBoq(updated)
      replaceEdits({})
      const syncedItems = data.sync?.affectedItems ?? 0
      toast.success(syncedItems > 0 ? `All changes saved · synced ${syncedItems} linked item${syncedItems === 1 ? "" : "s"}` : "All changes saved")
    } catch (error) {
      if (generation !== routeGenerationRef.current) return
      toast.error(error instanceof Error ? error.message : "Failed to save changes")
    } finally {
      if (generation === routeGenerationRef.current) setSaving(false)
    }
  }

  const handleMetaEdit = async (field: string, value: string) => {
    if (!boq || boq.status === "approved" || mutationBusy) return
    const generation = routeGenerationRef.current
    setUpdatingMeta(field)
    try {
      const res = await fetch(`/api/boqs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) throw new Error("Failed to update")
      const updated = await res.json()
      if (generation !== routeGenerationRef.current) return
      setBoq(updated)
      toast.success(`${field.charAt(0).toUpperCase() + field.slice(1)} updated`)
    } catch {
      if (generation !== routeGenerationRef.current) return
      toast.error("Failed to update")
    } finally {
      if (generation === routeGenerationRef.current) setUpdatingMeta(null)
    }
  }

  const handleApprove = async () => {
    if (!boq || mutationBusy) return
    if (Object.keys(editsRef.current).length > 0) {
      toast.error("Save pending item changes before approving")
      return
    }
    const generation = routeGenerationRef.current
    setApproving(true)
    try {
      const res = await fetch(`/api/boqs/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      })
      if (!res.ok) throw new Error("Failed to approve")
      const updated = await res.json()
      if (generation !== routeGenerationRef.current) return
      setBoq(updated)
      const reviewCount = updated.sections.flatMap((section: Boq["sections"][number]) => section.items)
        .filter((item: Boq["sections"][number]["items"][number]) => item.stdStatus !== "matched").length
      toast.success(
        reviewCount > 0
          ? `BOQ approved · ${reviewCount} ${reviewCount === 1 ? "item" : "items"} sent to Catalog review`
          : "BOQ approved and linked to the Standard Catalog",
      )
    } catch {
      if (generation !== routeGenerationRef.current) return
      toast.error("Failed to approve")
    } finally {
      if (generation === routeGenerationRef.current) setApproving(false)
    }
  }

  const handleStdAccept = (si: number, ii: number) => {
    if (!boq || mutationBusy) return
    const item = boq.sections[si]?.items[ii]
    if (!item) return
    handleStdMatch(si, ii, item.stdMatch || item.desc)
    toast.info("Choose a verified catalog entry to accept this suggestion")
  }

  const handleStdReject = (si: number, ii: number) => {
    if (!boq || mutationBusy) return
    const key = `${si}-${ii}`
    handleEdit(key, "stdStatus", "unmatched")
    handleEdit(key, "stdMatch", undefined)
    toast.info("Suggestion dismissed")
  }

  const handleStdMatch = (si: number, ii: number, descriptionOverride?: string) => {
    if (!boq || mutationBusy) return
    const item = boq.sections[si].items[ii]
    const edited = edits[`${si}-${ii}`]
    setCatalogMatchTarget({
      si,
      ii,
      ...getBoqItemRequestIdentity(item),
      desc: descriptionOverride || (edited?.desc as string) || item.desc,
      unit: (edited?.unit as string) || item.unit,
    })
  }

  const handleCatalogMatch = async (standardId: string, standardDesc: string) => {
    if (!catalogMatchTarget || !boq || mutationBusy) return
    if (!standardId.trim()) {
      toast.error("The catalog match did not return a valid standard ID")
      return
    }

    const key = `${catalogMatchTarget.si}-${catalogMatchTarget.ii}`
    setMatching(true)
    try {
      const res = await fetch(`/api/boqs/${id}`)
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(errorBody?.error || "The updated BOQ could not be loaded")
      }

      const updated = await res.json() as Boq
      setBoq(updated)

      const currentEdit = editsRef.current[key]
      if (currentEdit) {
        const unrelatedEdits = { ...currentEdit }
        delete unrelatedEdits.desc
        delete unrelatedEdits.unit
        delete unrelatedEdits.stdMatch
        delete unrelatedEdits.stdStatus
        const nextEdits = { ...editsRef.current }
        if (Object.keys(unrelatedEdits).length > 0) nextEdits[key] = unrelatedEdits
        else delete nextEdits[key]
        replaceEdits(nextEdits)
      }

      setCatalogMatchTarget(null)
      toast.success(`Matched to: "${standardDesc}"`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The catalog match could not be applied")
    } finally {
      setMatching(false)
    }
  }

  const handleLlmSuggest = async () => {
    if (!boq || mutationBusy) return
    const candidates = boq.sections.flatMap((section, si) => section.items.map((item, ii) => ({ item, si, ii })))
      .filter(({ item, si, ii }) => {
        const status = edits[`${si}-${ii}`]?.stdStatus ?? item.stdStatus
        return status === "unmatched" || status === "pending"
      })
    if (candidates.length === 0) return void toast.info("No unmatched items to suggest")
    setMatching(true)
    try {
      const response = await fetch("/api/llm/standardize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: candidates.map(({ item, si, ii }) => ({ key: `${si}-${ii}`, description: item.desc, unit: item.unit })),
        }),
      })
      if (!response.ok) throw new Error("LLM suggestions are unavailable")
      const result = await response.json() as { suggestions?: Array<{ key: string; description: string }> }
      for (const suggestion of result.suggestions ?? []) {
        handleEdit(suggestion.key, "stdStatus", "llm")
        handleEdit(suggestion.key, "stdMatch", suggestion.description)
      }
      toast.success(`${result.suggestions?.length ?? 0} catalog suggestion${result.suggestions?.length === 1 ? "" : "s"} ready to review`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "LLM suggestions are unavailable")
    } finally {
      setMatching(false)
    }
  }

  const handleAcceptAll = () => {
    if (!boq || mutationBusy) return
    for (let si = 0; si < boq.sections.length; si += 1) {
      for (let ii = 0; ii < boq.sections[si].items.length; ii += 1) {
        const item = boq.sections[si].items[ii]
        const key = `${si}-${ii}`
        const current = edits[key]
        const stdStatus = ((current?.stdStatus ?? item.stdStatus) || "") as string
        if (stdStatus === "fuzzy" || stdStatus === "llm") {
          handleStdMatch(si, ii, item.stdMatch || item.desc)
          toast.info("Choose a verified catalog entry; each accepted match is saved immediately")
          return
        }
      }
    }
    toast.info("No suggestions to accept")
  }

  const handleExportCsv = () => {
    if (!boq) return
    const rows = [["Section", "Code", "Description", "Unit", "Qty", "Rate", "Total", "Type", "Std Status", "Std Match"]]
    boq.sections.forEach((section) => {
      section.items.forEach((item) => {
        rows.push([
          section.header,
          item.code ?? "",
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
    const key = `${si}-${ii}`
    if (!boq || mutationBusy) return
    const item = boq.sections[si]?.items[ii]
    if (!item) return
    const confirmation = boq.status === "approved"
      ? window.prompt("This BOQ is approved. Type DELETE to remove this item.") === "DELETE"
      : window.confirm("Remove this item from the BOQ?")
    if (!confirmation) return
    const sectionRemoved = boq.sections[si].items.length === 1
    const generation = routeGenerationRef.current
    setDeletingItem(key)
    try {
      const res = await fetch(`/api/boqs/${id}/items`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionIndex: si, ...getBoqItemRequestIdentity(item) }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error || "Failed to delete")
      }
      const updated = await res.json()
      if (generation !== routeGenerationRef.current) return
      setBoq(updated)
      replaceEdits(reindexEditsAfterDelete(editsRef.current, si, ii, sectionRemoved))
      setEditingKey(null)
      toast.success("Item removed")
    } catch (error) {
      if (generation !== routeGenerationRef.current) return
      toast.error(error instanceof Error ? error.message : "Failed to remove item")
    } finally {
      if (generation === routeGenerationRef.current) setDeletingItem(null)
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
                const code = (edited.code as string) || item.code || ""
                if (!desc.toLowerCase().includes(q) && !code.toLowerCase().includes(q)) return false
              }
              return true
            }),
        }))
        .filter((s) => s.items.length > 0)
    : []

  const grandTotal = boq
    ? boq.sections.reduce(
        (sum, section, si) => sum + section.items.reduce(
          (sectionSum, item, ii) => sectionSum + mergeItemEdits(item, edits[`${si}-${ii}`]).total,
          0
        ),
        0
      )
    : 0

  const editsCount = Object.keys(edits).length
  const isReadOnly = boq?.status === "approved"

  const handleDeleteBoq = async () => {
    if (!boq || mutationBusy) return
    const typed = window.prompt(`Delete the entire BOQ and source PDF? Type “${boq.project}” to confirm.`)
    if (typed !== boq.project) return
    const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, { method: "DELETE" })
    if (!response.ok) return void toast.error("The BOQ could not be deleted")
    window.location.assign("/boqs")
  }

  if (loadState === "loading") {
    return (
      <div className="proto-empty-state boq-detail-state" data-od-id="loading-state" role="status">
        <div className="flex items-center gap-2">
          <span className="proto-spinner" aria-hidden="true" />
          Loading BOQ…
        </div>
      </div>
    )
  }

  if (loadState === "error") {
    return (
      <div className="proto-empty-state boq-detail-state" data-od-id="error-state" role="alert">
        <AlertCircle aria-hidden="true" />
        <h3>Couldn’t load this BOQ</h3>
        <p>The server did not return the BOQ. Your data has not been changed.</p>
        <button className="btn btn-primary" onClick={() => void fetchBoq()}>Retry</button>
      </div>
    )
  }

  if (loadState === "not-found" || !boq) {
    return (
      <div className="proto-empty-state boq-detail-state" data-od-id="not-found-state">
        <AlertCircle aria-hidden="true" />
        <h3>BOQ not found</h3>
        <p>It may have been removed, or the link may be incorrect.</p>
        <Link href="/boqs" className="btn btn-secondary">Back to BOQs</Link>
      </div>
    )
  }

  return (
    <div className="boq-detail-page" data-od-id="boq-detail">
      <header className="boq-detail-header" data-od-id="detail-header">
        <div className="boq-detail-heading">
          <Link
            href="/boqs"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground no-underline"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </Link>
          <h1>{boq.project}</h1>
          <ProtoBadge status={boq.status} />
          {isReadOnly && <span className="boq-readonly-note"><Lock aria-hidden="true" /> Approved · read only</span>}
        </div>
        <div className="boq-detail-actions">
          {boq.status !== "approved" && boq.sourceAvailable ? (
            <button onClick={() => setReviewOpen(true)} className="btn btn-ghost btn-sm">
              <Eye className="w-3.5 h-3.5" /> Review source
            </button>
          ) : null}
          <button onClick={() => window.print()} className="btn btn-ghost btn-sm">
            <FileDown className="w-3.5 h-3.5" />
            Download PDF
          </button>
          <button onClick={handleExportCsv} className="btn btn-ghost btn-sm">
            <FileDown className="w-3.5 h-3.5" />
            Export CSV
          </button>
          {boq.status !== "approved" && (
            <button onClick={handleApprove} className="btn btn-primary btn-sm" disabled={mutationBusy || editsCount > 0}>
              {approving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {approving ? "Approving…" : "Approve"}
            </button>
          )}
          <button onClick={() => void handleDeleteBoq()} className="btn btn-ghost btn-sm text-destructive" disabled={mutationBusy}>
            <Trash2 className="w-3.5 h-3.5" /> Delete BOQ
          </button>
        </div>
      </header>

      <div
        className="boq-meta-grid"
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
            disabled={isReadOnly || mutationBusy}
            saving={updatingMeta === meta.key}
            field={meta.key}
            onSave={handleMetaEdit}
            type={meta.type}
            options={meta.options}
          />
        ))}
      </div>

      <div className="boq-detail-toolbar" data-od-id="toolbar">
        <div className="boq-detail-toolbar-main">
          <div className="search-wrap">
            <Search />
            <Input
              placeholder="Search items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="proto-input"
            />
          </div>
          <div className="boq-detail-filters" aria-label="Filter BOQ items">
            {FILTERS.map((f) => (
              <button
                key={f}
                data-filter={f.toLowerCase().replace(/\s+/g, "_")}
                onClick={() => setActiveFilter(f)}
                aria-pressed={activeFilter === f}
                className={`filter-chip ${activeFilter === f ? "active" : ""}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="boq-detail-toolbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={handleLlmSuggest} disabled={mutationBusy}>
            <Sparkles className="w-3 h-3" />
            LLM Suggest
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleAcceptAll} disabled={mutationBusy}>
            Accept All
          </button>
          {editsCount > 0 && (
            <button className="btn btn-primary btn-sm" onClick={handleSaveAll} disabled={mutationBusy || isReadOnly}>
              <Save className="w-3 h-3" />
              {saving ? "Saving…" : `Save all changes (${editsCount})`}
            </button>
          )}
        </div>
      </div>

      <div data-od-id="boq-sections" className="boq-detail-sections">
          {filteredSections.map((section) => {
          const si = section.realSi
          const sectionTotal = section.items.reduce(
            (sum, { item, ii }) => sum + mergeItemEdits(item, edits[`${si}-${ii}`]).total,
            0
          )
          return (
            <CollapsibleSection
              key={si}
              title={section.header}
              subtitle={`${section.items.length} items · ฿${sectionTotal.toLocaleString()}`}
            >
              <div className="data-table-wrap boq-items-table-wrap">
                <table className="data-table boq-items-table">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Code</th>
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Description</th>
                      <th className="text-left p-2.5 font-medium text-xs text-muted-foreground">Unit</th>
                      <th className="text-right p-2.5 font-medium text-xs text-muted-foreground">Qty</th>
                      <th className="text-right p-2.5 font-medium text-xs text-muted-foreground">Rate</th>
                      <th className="text-right p-2.5 font-medium text-xs text-muted-foreground">Material</th>
                      <th className="text-right p-2.5 font-medium text-xs text-muted-foreground">Labour</th>
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
                      const display = mergeItemEdits(item, edited)
                      const hasEdits = key in edits
                      const isEditing = editingKey === key

                      return (
                        <tr
                          key={getBoqItemIdentityKey(item) ?? `${si}-${ii}`}
                          data-item-id={key}
                          className={`boq-item-row ${
                            hasEdits ? "bg-[#eab308]/6" : ""
                          } ${isEditing ? "bg-accent/6" : ""}`}
                        >
                          <td className="p-2.5">
                            {isEditing && !isReadOnly ? (
                              <Input
                                disabled={mutationBusy}
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
                            {isEditing && !isReadOnly ? (
                              <Input
                                disabled={mutationBusy}
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
                            {isEditing && !isReadOnly ? (
                              <Input
                                disabled={mutationBusy}
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
                            {isEditing && !isReadOnly ? (
                              <Input
                                disabled={mutationBusy}
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
                            {isEditing && !isReadOnly ? (
                              <Input
                                disabled={mutationBusy}
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
                          {(["material", "labour"] as const).map((component) => {
                            const allocation = deriveSourceCostAllocation(display)
                            const field = component === "material" ? "materialCost" : "labourCost"
                            const value = allocation?.[component]
                            return (
                              <td key={component} className="p-2.5 text-right font-mono text-xs">
                                {isEditing && !isReadOnly ? (
                                  <Input
                                    disabled={mutationBusy}
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    defaultValue={value ?? 0}
                                    aria-label={`${component} cost for ${display.desc}`}
                                    className="h-7 w-24 text-xs text-right"
                                    onBlur={(event) => handleEdit(key, field, Number(event.target.value) || 0)}
                                  />
                                ) : value !== undefined ? (
                                  <span title={`${allocation?.origin === "source" ? "Parsed from source" : "Manual"} · ${allocation?.basis === "total" ? "total allocation" : "unit rate"}`}>฿{value.toLocaleString()}</span>
                                ) : (
                                  <span className="text-muted-foreground" title="No reliable split was present in the source. Edit this row to allocate material and labour.">Not split</span>
                                )}
                              </td>
                            )
                          })}
                          <td className="p-2.5 text-right font-mono text-xs">
                            ฿{display.total.toLocaleString()}
                          </td>
                          <td className="p-2.5">
                            {isEditing && !isReadOnly ? (
                              <select
                                disabled={mutationBusy}
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
                            <StdContent
                              item={display}
                              onMatch={() => handleStdMatch(si, ii)}
                              onAccept={() => handleStdAccept(si, ii)}
                              onReject={() => handleStdReject(si, ii)}
                              disabled={mutationBusy}
                            />
                          </td>
                          <td className="p-2.5">
                            {isEditing && !isReadOnly ? (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => {
                                    setEditingKey(null)
                                  }}
                                  className="btn btn-primary btn-xs"
                                  disabled={mutationBusy}
                                >
                                  Done
                                </button>
                                <button
                                  onClick={() => void handleDeleteItem(si, ii)}
                                  className="text-xs px-2 py-1 rounded text-destructive hover:bg-destructive/10"
                                  disabled={mutationBusy}
                                >
                                  {deletingItem === key ? "Deleting…" : "Delete"}
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
                                {!isReadOnly && (
                                  <button
                                    onClick={() => setEditingKey(key)}
                                    className="btn btn-ghost btn-xs boq-item-edit"
                                    disabled={mutationBusy}
                                  >
                                    Edit
                                  </button>
                                )}
                                {isReadOnly && (
                                  <button onClick={() => void handleDeleteItem(si, ii)} className="btn btn-ghost btn-xs text-destructive" disabled={mutationBusy}>
                                    {deletingItem === key ? "Deleting…" : "Delete"}
                                  </button>
                                )}
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
        className="estimate-summary boq-detail-summary"
        data-od-id="summary-bar"
      >
        <div>
          <div className="total-label">{boq.totalItems} items</div>
          <div className="total-value">฿{grandTotal.toLocaleString()}</div>
        </div>
        <div className="total-actions">
          <button
            className="btn btn-primary"
            disabled
            title="No estimator import workflow is available in this prototype yet"
            aria-describedby="estimate-import-note"
          >
            Add to Estimate
          </button>
          <span id="estimate-import-note" className="sr-only">No estimator import workflow is available in this prototype yet.</span>
        </div>
      </div>

      {catalogMatchTarget && (
        <CatalogMatchModal
          itemDesc={catalogMatchTarget.desc}
          itemUnit={catalogMatchTarget.unit}
          itemCode={catalogMatchTarget.itemCode}
          sourceProject={boq.project}
          sourceVendor={boq.vendor}
          onMatch={handleCatalogMatch}
          onClose={() => setCatalogMatchTarget(null)}
          matchContext={{
            boqId: id,
            sectionIndex: catalogMatchTarget.si,
            ...(catalogMatchTarget.itemId ? { itemId: catalogMatchTarget.itemId } : { itemCode: catalogMatchTarget.itemCode }),
          }}
        />
      )}
      {reviewOpen ? (
        <ReviewPanel
          boq={boq}
          onClose={() => setReviewOpen(false)}
          onApproved={(updated) => { setBoq(updated); setReviewOpen(false) }}
        />
      ) : null}
    </div>
  )
}

function MetaField({
  label,
  value,
  editable,
  field,
  onSave,
  disabled,
  saving,
  type = "text",
  options,
}: {
  label: string
  value: string
  editable: boolean
  field: string | null
  onSave: (field: string, value: string) => void
  disabled: boolean
  saving: boolean
  type?: "text" | "select" | "date"
  options?: string[]
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const handleSave = () => {
    if (field && draft !== value) {
      onSave(field, draft)
    }
    setEditing(false)
  }

  return (
    <div className="boq-meta-item" data-meta={field || undefined}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
          {label}
        </span>
        {editable && !editing && (
          <button
            onClick={() => {
              setDraft(value)
              setEditing(true)
            }}
            className="boq-meta-edit"
            disabled={disabled}
          >
            {saving ? "Saving…" : "Edit"}
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
            className="proto-input"
            autoFocus
          />
        )
      ) : (
        <div className="text-sm font-medium">{value}</div>
      )}
    </div>
  )
}
