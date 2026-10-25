"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { ProtoBadge } from "@/components/proto-badge"
import { ProtoDataTable } from "@/components/proto-data-table"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Search, Plus, Check, X, Pencil, Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { Boq, BoqItem } from "@/lib/boq-schema"
import type { StandardEntry } from "@/lib/standard-schema"
import { CatalogMatchModal } from "@/components/catalog-match-modal"
import { normalizeCatalogText } from "@/lib/standard-matching"
import { getBoqItemIdentityKey, getBoqItemRequestIdentity } from "@/lib/boq-item-identity"
import { collectCatalogReviewItems, type CatalogReviewItem as ReviewItem } from "@/lib/catalog-review-queue"

const BOQ_PAGE_LIMIT = 1000

function formatCurrency(value: number): string {
  return `฿${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

async function fetchAllBoqs(signal: AbortSignal): Promise<Boq[]> {
  const firstResponse = await fetch(`/api/boqs?page=1&limit=${BOQ_PAGE_LIMIT}`, { signal })
  if (!firstResponse.ok) throw new Error("Catalog data could not be loaded.")

  const firstPage = await firstResponse.json() as { boqs?: unknown; totalPages?: unknown }
  if (!Array.isArray(firstPage.boqs)) throw new Error("Catalog data returned an invalid BOQ response.")

  const totalPages = typeof firstPage.totalPages === "number"
    && Number.isSafeInteger(firstPage.totalPages)
    && firstPage.totalPages > 0
    ? firstPage.totalPages
    : 1

  if (totalPages === 1) return firstPage.boqs as Boq[]

  const pageResponses = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) =>
      fetch(`/api/boqs?page=${index + 2}&limit=${BOQ_PAGE_LIMIT}`, { signal }),
    ),
  )
  const pages = await Promise.all(pageResponses.map(async (response) => {
    if (!response.ok) throw new Error("Catalog data could not be loaded.")
    const page = await response.json() as { boqs?: unknown }
    if (!Array.isArray(page.boqs)) throw new Error("Catalog data returned an invalid BOQ response.")
    return page.boqs as Boq[]
  }))

  return [firstPage.boqs as Boq[], ...pages].flat()
}

export default function CatalogPage() {
  const [tab, setTab] = useState("review")
  const [standards, setStandards] = useState<StandardEntry[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [catalogSearch, setCatalogSearch] = useState("")

  const [editingId, setEditingId] = useState<string | null>(null)
  const [standardMutation, setStandardMutation] = useState<{ kind: "save" | "delete" | "add"; id: string } | null>(null)
  const standardMutationRef = useRef<{ kind: "save" | "delete" | "add"; id: string } | null>(null)
  const [editDesc, setEditDesc] = useState("")
  const [editUnit, setEditUnit] = useState("")
  const [editAliases, setEditAliases] = useState("")

  const [addOpen, setAddOpen] = useState(false)
  const [addDesc, setAddDesc] = useState("")
  const [addUnit, setAddUnit] = useState("")
  const [addAliases, setAddAliases] = useState("")

  const [acceptingIds, setAcceptingIds] = useState<Set<string>>(new Set())
  const [suggestingAll, setSuggestingAll] = useState(false)
  const [matchTarget, setMatchTarget] = useState<ReviewItem | null>(null)
  const [pricingTarget, setPricingTarget] = useState<StandardEntry | null>(null)
  const [mutatingBoqs, setMutatingBoqs] = useState<Set<string>>(new Set())
  const mutatingBoqsRef = useRef<Set<string>>(new Set())
  const bulkMutationRef = useRef(false)
  const loadAbortRef = useRef<AbortController | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const fetchData = useCallback(async () => {
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const [standardsRes, boqs] = await Promise.all([
        fetch("/api/standards", { signal: controller.signal }),
        fetchAllBoqs(controller.signal),
      ])

      if (!standardsRes.ok) throw new Error("Catalog data could not be loaded.")

      const standardsData: StandardEntry[] = await standardsRes.json()

      setStandards(Array.isArray(standardsData) ? standardsData : [])

      setReviewItems(collectCatalogReviewItems(boqs))
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setLoadError(error instanceof Error ? error.message : "Catalog data could not be loaded.")
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(fetchData)
    return () => loadAbortRef.current?.abort()
  }, [fetchData])

  const suggestions = reviewItems.filter((i) => i.stdStatus === "pending").length
  const unmatched = reviewItems.filter((i) => i.stdStatus === "unmatched").length
  const awaitingReview = suggestions + unmatched

  const beginBoqMutation = (boqId: string) => {
    if (bulkMutationRef.current || mutatingBoqsRef.current.has(boqId)) return false
    mutatingBoqsRef.current = new Set(mutatingBoqsRef.current).add(boqId)
    setMutatingBoqs(mutatingBoqsRef.current)
    return true
  }

  const endBoqMutation = (boqId: string) => {
    const next = new Set(mutatingBoqsRef.current)
    next.delete(boqId)
    mutatingBoqsRef.current = next
    setMutatingBoqs(next)
  }

  const persistMatch = async (item: ReviewItem, stdStatus: BoqItem["stdStatus"], stdMatch?: string) => {
    if (stdStatus === "matched") return false
    if (!beginBoqMutation(item.boqId)) return false
    const identity = getBoqItemRequestIdentity(item)
    const key = `${item.boqId}-${item.sectionIndex}-${getBoqItemIdentityKey(item) ?? "missing"}`
    setAcceptingIds((prev) => new Set(prev).add(key))
    try {
      const res = await fetch(`/api/boqs/${item.boqId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sectionIndex: item.sectionIndex,
          items: [{ ...identity, stdStatus, stdMatch }],
        }),
      })
      if (!res.ok) throw new Error("The item could not be updated.")
      await fetchData()
      return true
    } catch {
      toast.error("The item could not be updated. Try again.")
      return false
    } finally {
      endBoqMutation(item.boqId)
      setAcceptingIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const applyCatalogMatch = async (
    item: ReviewItem,
    standardId: string,
    confidence: NonNullable<BoqItem["stdConfidence"]>,
    bulk = false,
  ) => {
    if (!bulk && !beginBoqMutation(item.boqId)) return false
    const identity = getBoqItemRequestIdentity(item)
    const key = `${item.boqId}-${item.sectionIndex}-${getBoqItemIdentityKey(item) ?? "missing"}`
    setAcceptingIds((prev) => new Set(prev).add(key))
    try {
      const res = await fetch("/api/standards/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boqId: item.boqId,
          sectionIndex: item.sectionIndex,
          ...identity,
          standardId,
          confidence,
        }),
      })
      if (!res.ok) throw new Error("The catalog match could not be applied.")
      await fetchData()
      return true
    } catch {
      toast.error("The catalog match could not be applied. Try again.")
      return false
    } finally {
      if (!bulk) endBoqMutation(item.boqId)
      setAcceptingIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const resolveSuggestedStandard = (item: ReviewItem): StandardEntry | null => {
    if (item.stdId) {
      const standardById = standards.find((standard) => standard.id === item.stdId)
      if (standardById) return standardById
    }

    if (!item.stdMatch) return null
    const descriptionMatches = standards.filter(
      (standard) => normalizeCatalogText(standard.description) === normalizeCatalogText(item.stdMatch ?? ""),
    )
    if (descriptionMatches.length === 1) return descriptionMatches[0] ?? null

    const normalizedUnit = item.unit.trim().toLowerCase()
    return descriptionMatches.find((standard) => standard.unit.trim().toLowerCase() === normalizedUnit) ?? null
  }

  const handleAccept = async (item: ReviewItem) => {
    const suggestedStandard = resolveSuggestedStandard(item)
    if (!suggestedStandard) {
      toast.info("Choose a verified catalog entry before accepting this suggestion.")
      setMatchTarget(item)
      return
    }

    const updated = await applyCatalogMatch(item, suggestedStandard.id, "fuzzy")
    if (updated) toast.success(`Accepted: "${item.stdMatch || item.desc}"`)
  }

  const handleReject = async (item: ReviewItem) => {
    const updated = await persistMatch(item, "unmatched", "")
    if (updated) {
      toast.success("Suggestion declined — choose another standard.")
      setMatchTarget({ ...item, stdStatus: "unmatched", stdMatch: undefined })
    }
  }

  const handleManualMatch = async (standardId: string, standardDesc: string) => {
    if (!matchTarget) return
    if (!standardId.trim()) {
      toast.error("The catalog match did not return a valid standard ID.")
      return
    }
    toast.success(`Matched to: "${standardDesc}"`)
    setMatchTarget(null)
    await fetchData()
  }

  const handleSuggestAll = async () => {
    if (bulkMutationRef.current || mutatingBoqsRef.current.size > 0) return
    bulkMutationRef.current = true
    setSuggestingAll(true)
    const pending = reviewItems.filter((i) => i.stdStatus === "pending")

    let success = 0
    let failed = 0
    let skipped = 0
    try {
      for (const item of pending) {
        const suggestedStandard = resolveSuggestedStandard(item)
        if (!suggestedStandard) {
          skipped += 1
          continue
        }

        const updated = await applyCatalogMatch(item, suggestedStandard.id, "fuzzy", true)
        if (updated) success += 1
        else failed += 1
      }

      if (success === pending.length) {
      toast.success(`Accepted all ${success} suggestions`)
      } else if (success > 0) {
        toast.warning(`Accepted ${success}; ${failed + skipped} suggestions remain pending`)
      } else {
        toast.info("No suggestions had a verified catalog ID. Items remain pending.")
      }
      await fetchData()
    } finally {
      bulkMutationRef.current = false
      setSuggestingAll(false)
    }
  }

  const startEditing = (std: StandardEntry) => {
    if (standardMutationRef.current) return
    setEditingId(std.id)
    setEditDesc(std.description)
    setEditUnit(std.unit)
    setEditAliases((std.aliases || []).join(", "))
  }

  const saveEditing = async (id: string) => {
    if (standardMutationRef.current) return
    const standard = standards.find((entry) => entry.id === id)
    if (!standard) {
      toast.error("That catalog entry is no longer available. Reload the catalog and try again.")
      return
    }
    const sourceCount = Math.max(
      standard.sourceBoqCount ?? 0,
      new Set((standard.sourceItems ?? []).map((source) => source.boqId)).size,
    )
    if (!confirm(
      `Save changes to “${standard.description}”? This updates the canonical catalog fields for ${sourceCount} linked BOQ/source ${sourceCount === 1 ? "entry" : "entries"} globally. Continue?`,
    )) return

    const mutation = { kind: "save" as const, id }
    standardMutationRef.current = mutation
    setStandardMutation(mutation)
    try {
      const res = await fetch(`/api/standards/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: editDesc,
          unit: editUnit,
          aliases: editAliases.split(",").map((a) => a.trim()).filter(Boolean),
        }),
      })
      if (!res.ok) throw new Error("Failed to update")
      toast.success("Standard updated")
      setEditingId((current) => current === id ? null : current)
      await fetchData()
    } catch {
      toast.error("Failed to update standard")
    } finally {
      if (standardMutationRef.current === mutation) {
        standardMutationRef.current = null
        setStandardMutation(null)
      }
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this catalog entry? Linked BOQ or estimate items will be archived by the server.")) return
    if (standardMutationRef.current) return
    const mutation = { kind: "delete" as const, id }
    standardMutationRef.current = mutation
    setStandardMutation(mutation)
    try {
      const res = await fetch(`/api/standards/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      const result = await res.json() as { archived?: unknown; deleted?: unknown }
      if (result.archived === true) {
        toast.success("Catalog entry archived because linked BOQ or estimate entries still use it")
      } else {
        toast.success("Standard deleted")
      }
      await fetchData()
    } catch {
      toast.error("Failed to delete standard")
    } finally {
      if (standardMutationRef.current === mutation) {
        standardMutationRef.current = null
        setStandardMutation(null)
      }
    }
  }

  const handleAddEntry = async () => {
    if (!addDesc.trim() || !addUnit.trim()) {
      toast.error("Description and unit are required")
      return
    }
    if (standardMutationRef.current) return
    const mutation = { kind: "add" as const, id: "new-standard" }
    standardMutationRef.current = mutation
    setStandardMutation(mutation)
    try {
      const res = await fetch("/api/standards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: addDesc.trim(),
          unit: addUnit.trim(),
          aliases: addAliases.split(",").map((a) => a.trim()).filter(Boolean),
        }),
      })
      if (res.status === 409) {
        toast.error("This catalog entry already exists (same description and unit)")
        return
      }
      if (!res.ok) throw new Error("Failed to create")
      toast.success("Standard entry created")
      setAddOpen(false)
      setAddDesc("")
      setAddUnit("")
      setAddAliases("")
      await fetchData()
    } catch {
      toast.error("Failed to create standard entry")
    } finally {
      if (standardMutationRef.current === mutation) {
        standardMutationRef.current = null
        setStandardMutation(null)
      }
    }
  }

  const filteredStandards = standards.filter((s) => {
    if (s.archivedAt) return false
    if (!catalogSearch) return true
    const q = catalogSearch.toLowerCase()
    return (
      s.description.toLowerCase().includes(q) ||
      s.unit.toLowerCase().includes(q) ||
      s.aliases?.some((a) => a.toLowerCase().includes(q))
    )
  })

  const selectTab = (nextTab: "review" | "catalog") => setTab(nextTab)

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index
    if (event.key === "ArrowRight") nextIndex = (index + 1) % 2
    else if (event.key === "ArrowLeft") nextIndex = (index + 1) % 2
    else if (event.key === "Home") nextIndex = 0
    else if (event.key === "End") nextIndex = 1
    else return
    event.preventDefault()
    const nextTab = nextIndex === 0 ? "review" : "catalog"
    selectTab(nextTab)
    tabRefs.current[nextIndex]?.focus()
  }

  return (
    <div data-od-id="catalog-page">
      <div data-od-id="page-heading" className="mb-4">
        <h1 className="font-heading text-xl font-medium tracking-tight">Catalog</h1>
        <p className="text-sm text-muted-foreground">
          Keep one canonical language for estimating. Review incoming BOQ items, then maintain the active catalog that
          powers consistent estimate lines.
        </p>
      </div>

      <div className="catalog-tabs" role="tablist" aria-label="Catalog views">
        <button ref={(node) => { tabRefs.current[0] = node }} id="catalog-tab-review" role="tab" aria-selected={tab === "review"} aria-controls="catalog-panel-review" tabIndex={tab === "review" ? 0 : -1} className={`tab-btn ${tab === 'review' ? 'active' : ''}`} onClick={() => selectTab('review')} onKeyDown={(event) => handleTabKeyDown(event, 0)} data-od-id="catalog-tab-review">Items to Review</button>
        <button ref={(node) => { tabRefs.current[1] = node }} id="catalog-tab-standard" role="tab" aria-selected={tab === "catalog"} aria-controls="catalog-panel-standard" tabIndex={tab === "catalog" ? 0 : -1} className={`tab-btn ${tab === 'catalog' ? 'active' : ''}`} onClick={() => selectTab('catalog')} onKeyDown={(event) => handleTabKeyDown(event, 1)} data-od-id="catalog-tab-standard">Standard Catalog</button>
      </div>

      {tab === 'review' && (
        <div id="catalog-panel-review" role="tabpanel" aria-labelledby="catalog-tab-review" data-od-id="tab-review">
          <div className="review-stats" data-od-id="stats-bar">
            <div className="review-stat"><div className="num">{suggestions}</div><div className="label">Suggestions</div></div>
            <div className="review-stat"><div className="num">{unmatched}</div><div className="label">Unmatched items</div></div>
            <div className="review-stat"><div className="num">{awaitingReview}</div><div className="label">Awaiting review</div></div>
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-64 text-sm text-muted-foreground" data-od-id="loading-state">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading&hellip;
            </div>
          ) : loadError ? (
            <div className="proto-empty-state proto-error-state" role="alert" data-od-id="catalog-error">
              <p>{loadError}</p>
              <button className="btn btn-secondary btn-sm" onClick={() => void fetchData()} data-od-id="catalog-review-retry">Try again</button>
            </div>
          ) : reviewItems.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground"
              data-od-id="empty-state"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="w-10 h-10 opacity-40"
              >
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <p className="text-sm">All items are matched. Nothing to review.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-end mb-3">
                {suggestions > 0 && (
                  <button className="btn btn-primary btn-sm" onClick={handleSuggestAll} disabled={suggestingAll || mutatingBoqs.size > 0} data-od-id="suggest-all-btn">
                    {suggestingAll && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                    Suggest All
                  </button>
                )}
              </div>
              <ProtoDataTable
                headers={[
                  { label: 'Source BOQ' },
                  { label: 'Original Description' },
                  { label: 'Unit' },
                  { label: 'Match Status' },
                  { label: 'Suggested Standard' },
                  { label: 'Action', className: 'text-right whitespace-nowrap' },
                ]}
              >
                {reviewItems.map((item, i) => {
                  const key = `${item.boqId}-${item.sectionIndex}-${getBoqItemIdentityKey(item) ?? i}`
                  const isAccepting = acceptingIds.has(key)
                  return (
                    <tr key={key} data-od-id={`review-item-${i}`}>
                      <td className="catalog-source-cell">
                        <span className="flex items-center gap-2">{item.boqProject || 'Untitled BOQ'}<ProtoBadge status={item.boqStatus} /></span>
                        {item.boqVendor ? <small>Vendor: {item.boqVendor}</small> : <small>Vendor: —</small>}
                      </td>
                      <td>{item.desc}</td>
                      <td className="font-mono text-xs">{item.unit}</td>
                      <td><ProtoBadge status={item.stdStatus} /></td>
                      <td className="text-muted-foreground text-sm">{item.stdMatch || "\u2014"}</td>
                      <td className="text-right whitespace-nowrap">
                        {isAccepting ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : item.stdStatus === "pending" ? (
                          <div className="flex items-center gap-1 justify-end">
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground mr-1.5">Suggested</span>
                            <button
                              className="btn btn-primary btn-xs"
                              onClick={() => handleAccept(item)}
                              disabled={suggestingAll || mutatingBoqs.has(item.boqId)}
                              aria-label={`Accept suggested match for ${item.desc}`}
                              data-od-id={`accept-${i}`}
                            >
                              <Check className="w-3 h-3" />
                            </button>
                            <button
                              className="btn btn-ghost btn-xs"
                              onClick={() => handleReject(item)}
                              disabled={suggestingAll || mutatingBoqs.has(item.boqId)}
                              aria-label={`Reject suggested match for ${item.desc} and choose another`}
                              data-od-id={`reject-${i}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => setMatchTarget(item)}
                            disabled={suggestingAll || mutatingBoqs.has(item.boqId)}
                            data-od-id={`match-${i}`}
                          >
                            Match
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </ProtoDataTable>
            </>
          )}
        </div>
      )}

      {tab === 'catalog' && (
        <div id="catalog-panel-standard" role="tabpanel" aria-labelledby="catalog-tab-standard" data-od-id="tab-catalog">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-sm text-muted-foreground" data-od-id="loading-state">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading&hellip;
            </div>
          ) : loadError ? (
            <div className="proto-empty-state proto-error-state" role="alert" data-od-id="catalog-error">
              <p>{loadError}</p>
              <button className="btn btn-secondary btn-sm" onClick={() => void fetchData()} data-od-id="catalog-standard-retry">Try again</button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3" data-od-id="catalog-toolbar">
                <div className="search-wrap">
                  <Search className="w-4 h-4" />
                  <input
                    id="catalog-search"
                    className="proto-input"
                    aria-label="Search standard catalog"
                    placeholder="Search catalog…"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    data-od-id="catalog-search"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{filteredStandards.length} entries</span>
                  <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)} disabled={standardMutation !== null} data-od-id="add-entry-btn">
                    <Plus className="w-3 h-3" />
                    Add Entry
                  </button>
                </div>
              </div>
              <ProtoDataTable
                headers={[
                  { label: 'Description' },
                  { label: 'Unit' },
                  { label: 'Aliases' },
                  { label: 'Average approved unit price' },
                  { label: 'Source BOQ Count' },
                  { label: 'Last Updated' },
                  { label: 'Actions', className: 'text-right whitespace-nowrap' },
                ]}
              >
                {filteredStandards.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center text-muted-foreground py-8">
                      No catalog entries found
                    </td>
                  </tr>
                ) : (
                  filteredStandards.map((std) => {
                    const isEditing = editingId === std.id
                    return (
                      <tr key={std.id} data-od-id={`catalog-row-${std.id}`}>
                        {isEditing ? (
                          <>
                            <td>
                              <Input
                                value={editDesc}
                                onChange={(e) => setEditDesc(e.target.value)}
                                disabled={standardMutation !== null}
                                className="h-7 text-xs"
                                aria-label={`Description for ${std.description}`}
                                data-od-id={`edit-description-${std.id}`}
                              />
                            </td>
                            <td>
                              <Input
                                value={editUnit}
                                onChange={(e) => setEditUnit(e.target.value)}
                                disabled={standardMutation !== null}
                                className="h-7 text-xs font-mono w-16"
                                aria-label={`Unit for ${std.description}`}
                                data-od-id={`edit-unit-${std.id}`}
                              />
                            </td>
                            <td>
                              <Input
                                value={editAliases}
                                onChange={(e) => setEditAliases(e.target.value)}
                                disabled={standardMutation !== null}
                                className="h-7 text-xs"
                                placeholder="Comma-separated"
                                aria-label={`Aliases for ${std.description}`}
                                data-od-id={`edit-aliases-${std.id}`}
                              />
                            </td>
                            <td className="text-xs text-muted-foreground">
                              {std.historicalPricing
                                ? `${formatCurrency(std.historicalPricing.average)} / ${std.unit}`
                                : "No approved matched history"}
                            </td>
                            <td>{std.sourceBoqCount}</td>
                            <td className="text-xs text-muted-foreground">
                              {std.updatedAt ? new Date(std.updatedAt).toLocaleDateString() : "\u2014"}
                            </td>
                            <td className="text-right whitespace-nowrap">
                              <div className="flex items-center gap-1 justify-end">
                                <button className="btn btn-primary btn-xs" onClick={() => saveEditing(std.id)} disabled={standardMutation !== null} aria-label={`Save changes to ${std.description}`} data-od-id={`catalog-save-entry-${std.id}`}>
                                  {standardMutation?.kind === "save" && standardMutation.id === std.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                </button>
                                <button className="btn btn-ghost btn-xs" onClick={() => setEditingId(null)} disabled={standardMutation !== null} aria-label={`Cancel editing ${std.description}`} data-od-id={`catalog-cancel-edit-${std.id}`}>
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="font-medium">{std.description}</td>
                            <td className="font-mono text-xs">{std.unit}</td>
                            <td>
                              <div className="flex flex-wrap gap-1">
                                {(std.aliases || []).slice(0, 3).map((alias, ai) => (
                                  <span key={ai} className="inline-flex items-center gap-[5px] px-[10px] py-[2px] rounded-[9999px] text-[10px] font-medium tracking-[0.02em] whitespace-nowrap badge-draft">
                                    {alias}
                                  </span>
                                ))}
                                {(std.aliases || []).length > 3 && (
                                  <span className="text-[10px] text-muted-foreground">
                                    +{std.aliases.length - 3} more
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              {std.historicalPricing ? (
                                <button
                                  type="button"
                                  className="text-left rounded-md px-2 py-1 -mx-2 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={() => setPricingTarget(std)}
                                  data-od-id={`catalog-pricing-${std.id}`}
                                  aria-label={`See historical unit-price calculation for ${std.description}`}
                                >
                                  <span className="block font-medium tabular-nums">
                                    {formatCurrency(std.historicalPricing.average)} / {std.unit}
                                  </span>
                                  <span className="block text-[10px] text-muted-foreground">
                                    {std.historicalPricing.count} approved {std.historicalPricing.count === 1 ? "rate" : "rates"}
                                    {" · "}{formatCurrency(std.historicalPricing.min)}–{formatCurrency(std.historicalPricing.max)}
                                  </span>
                                </button>
                              ) : (
                                <span className="text-xs text-muted-foreground">No approved matched history</span>
                              )}
                            </td>
                            <td>{std.sourceBoqCount}</td>
                            <td className="text-xs text-muted-foreground">
                              {std.updatedAt ? new Date(std.updatedAt).toLocaleDateString() : "\u2014"}
                            </td>
                            <td className="text-right whitespace-nowrap">
                              <div className="flex items-center gap-1 justify-end">
                                <button
                                  className="btn btn-ghost btn-xs"
                                  onClick={() => startEditing(std)}
                                  disabled={standardMutation !== null}
                                  aria-label={`Edit ${std.description}`}
                                  data-od-id={`edit-${std.id}`}
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  className="btn btn-ghost btn-xs"
                                  onClick={() => handleDelete(std.id)}
                                  disabled={standardMutation !== null}
                                  aria-label={`Delete ${std.description}`}
                                  data-od-id={`delete-${std.id}`}
                                >
                                  {standardMutation?.kind === "delete" && standardMutation.id === std.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3 text-destructive" />}
                                </button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    )
                  })
                )}
              </ProtoDataTable>
            </>
          )}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(open) => {
        if (standardMutationRef.current?.kind !== "add") setAddOpen(open)
      }}>
        <DialogContent data-od-id="catalog-add-entry-dialog">
          <DialogHeader>
            <DialogTitle>Add Standard Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label htmlFor="catalog-add-description" className="text-xs font-medium mb-1 block">Description *</label>
              <Input
                id="catalog-add-description"
                value={addDesc}
                onChange={(e) => setAddDesc(e.target.value)}
                disabled={standardMutation?.kind === "add"}
                placeholder="e.g. Concrete C32/40 — columns"
                data-od-id="catalog-add-description"
              />
            </div>
            <div>
              <label htmlFor="catalog-add-unit" className="text-xs font-medium mb-1 block">Unit *</label>
              <Input
                id="catalog-add-unit"
                value={addUnit}
                onChange={(e) => setAddUnit(e.target.value)}
                disabled={standardMutation?.kind === "add"}
                placeholder="e.g. m³"
                className="font-mono w-24"
                data-od-id="catalog-add-unit"
              />
            </div>
            <div>
              <label htmlFor="catalog-add-aliases" className="text-xs font-medium mb-1 block">Aliases</label>
              <Input
                id="catalog-add-aliases"
                value={addAliases}
                onChange={(e) => setAddAliases(e.target.value)}
                disabled={standardMutation?.kind === "add"}
                placeholder="Comma-separated aliases"
                data-od-id="catalog-add-aliases"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Optional. Separate with commas.</p>
            </div>
          </div>
          <DialogFooter>
            <button className="btn btn-primary" onClick={handleAddEntry} disabled={standardMutation !== null} data-od-id="catalog-create-entry">
              {standardMutation?.kind === "add" ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {standardMutation?.kind === "add" ? "Creating…" : "Create Entry"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(pricingTarget)} onOpenChange={(open) => {
        if (!open) setPricingTarget(null)
      }}>
        <DialogContent className="sm:max-w-4xl" data-od-id="catalog-pricing-dialog">
          <DialogHeader>
            <DialogTitle>Historical unit-price calculation</DialogTitle>
            <DialogDescription>
              Approved, explicitly matched BOQ items with a compatible unit. Unmatched and draft items are excluded.
            </DialogDescription>
          </DialogHeader>
          {pricingTarget?.historicalPricing ? (
            <div className="space-y-4">
              <div>
                <p className="font-medium">{pricingTarget.description}</p>
                <p className="text-xs text-muted-foreground">Catalog unit: {pricingTarget.unit}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Approved rates", String(pricingTarget.historicalPricing.count)],
                  ["Average", formatCurrency(pricingTarget.historicalPricing.average)],
                  ["Minimum", formatCurrency(pricingTarget.historicalPricing.min)],
                  ["Maximum", formatCurrency(pricingTarget.historicalPricing.max)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="mt-1 font-medium tabular-nums">{value}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border overflow-hidden">
                <div className="max-h-[340px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background border-b">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Project / BOQ</th>
                        <th className="px-3 py-2 font-medium">Vendor / date</th>
                        <th className="px-3 py-2 font-medium">Source item</th>
                        <th className="px-3 py-2 font-medium text-right">Unit rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {pricingTarget.historicalPricing.sources.map((source) => (
                        <tr key={`${source.boqId}-${source.section}-${source.itemId ?? source.itemCode ?? source.description}`}>
                          <td className="px-3 py-2 align-top">
                            <span className="block font-medium">{source.project}</span>
                            <span className="text-xs text-muted-foreground">{source.section}</span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span className="block">{source.vendor || "Unknown vendor"}</span>
                            <span className="text-xs text-muted-foreground">{source.date || "No date"}</span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span className="block">{source.description}</span>
                            <span className="font-mono text-xs text-muted-foreground">{source.unit}</span>
                          </td>
                          <td className="px-3 py-2 text-right align-top font-medium tabular-nums">
                            {formatCurrency(source.rate)} / {source.unit}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Arithmetic mean: ({pricingTarget.historicalPricing.sources.map((source) => formatCurrency(source.rate)).join(" + ")}) ÷ {pricingTarget.historicalPricing.count} = {formatCurrency(pricingTarget.historicalPricing.average)}
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      {matchTarget ? (
        <CatalogMatchModal
          itemDesc={matchTarget.desc}
          itemUnit={matchTarget.unit}
          itemCode={matchTarget.code}
          sourceProject={matchTarget.boqProject}
          sourceVendor={matchTarget.boqVendor}
          onMatch={handleManualMatch}
          onClose={() => setMatchTarget(null)}
          matchContext={{
            boqId: matchTarget.boqId,
            sectionIndex: matchTarget.sectionIndex,
            ...getBoqItemRequestIdentity(matchTarget),
          }}
        />
      ) : null}
    </div>
  )
}
