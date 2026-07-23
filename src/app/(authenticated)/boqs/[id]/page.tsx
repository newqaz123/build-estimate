"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import {
  AlertCircle,
  Check,
  ChevronLeft,
  FileDown,
  FileSearch,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  Printer,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { CatalogMatchModal } from "@/components/catalog-match-modal"
import { ExtractionReview } from "@/components/extraction-review"
import { PdfReviewViewer } from "@/components/pdf-review-viewer"
import { ProtoBadge } from "@/components/proto-badge"
import { ReviewWorkspace } from "@/components/review-workspace"
import { UnifiedBoqItemsTable } from "@/components/unified-boq-items-table"
import { useInlineCatalogMatching } from "@/components/use-inline-catalog-matching"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { buildBoqCsv } from "@/lib/boq-csv"
import { getBoqCatalogReadiness } from "@/lib/boq-catalog-readiness"
import { applyManualCostAllocation, deriveSourceCostAllocation } from "@/lib/boq-cost-allocation"
import { reconcileBoqMutation, type BoqDetailEdits } from "@/lib/boq-detail-state"
import { getBoqItemRequestIdentity } from "@/lib/boq-item-identity"
import { calculateBoqTotals, isPricedBoqItem, parseNonNegativeBoqEditValue } from "@/lib/boq-pricing"
import { boqDetailHref, isBoqReviewMode } from "@/lib/boq-review-route"
import { buildCanonicalRevisionKey, buildReviewVerification } from "@/lib/boq-review-state"
import type { Boq, BoqItem, BoqPricedItem, WorkType } from "@/lib/boq-schema"
import {
  buildUnifiedBoqSections,
  type UnifiedBoqPricedRow,
} from "@/lib/boq-unified-rows"

type ItemEdit = Record<string, string | number | undefined>
type EditsMap = BoqDetailEdits
type LoadState = "loading" | "loaded" | "not-found" | "error"
type MetadataField = "vendor" | "project" | "workType" | "date"
type MetadataEdits = Partial<Pick<Boq, MetadataField>>
type RightPaneMode = "items" | "extraction"

const FILTERS = ["All", "Unit", "Lump Sum", "Job"] as const
const requireCatalogReadiness = true

function rowEditKey(row: Pick<UnifiedBoqPricedRow, "sectionIndex" | "itemIndex">): string {
  return `${row.sectionIndex}-${row.itemIndex}`
}

function mergeItemEdits(item: BoqItem, edited: ItemEdit = {}): BoqItem {
  const { materialCost, labourCost, ...directEdits } = edited
  if (!isPricedBoqItem(item)) {
    return typeof directEdits.desc === "string" ? { ...item, desc: directEdits.desc } : item
  }
  let merged = { ...item, ...directEdits } as BoqPricedItem
  if (materialCost !== undefined || labourCost !== undefined) {
    const allocation = deriveSourceCostAllocation(item)
    merged = applyManualCostAllocation(
      merged,
      Number(materialCost ?? allocation?.material ?? 0),
      Number(labourCost ?? allocation?.labour ?? 0),
    )
  }
  if (directEdits.qty !== undefined || directEdits.rate !== undefined) merged.total = merged.qty * merged.rate
  return merged
}

function confidenceLabel(value: number | undefined): string | null {
  if (!Number.isFinite(value)) return null
  return `${Math.round((value ?? 0) * 100)}% confidence`
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    return typeof body.error === "string" ? body.error : fallback
  } catch {
    return fallback
  }
}

export default function BoqDetailPage() {
  return (
    <Suspense fallback={<div className="proto-loading-state"><div><Loader2 className="animate-spin" />Loading BOQ…</div></div>}>
      <BoqDetailContent />
    </Suspense>
  )
}

function BoqDetailContent() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = params.id as string
  const legacyReviewMode = isBoqReviewMode(searchParams)
  const [boq, setBoq] = useState<Boq | null>(null)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const fetchControllerRef = useRef<AbortController | null>(null)

  const fetchBoq = useCallback(async () => {
    fetchControllerRef.current?.abort()
    const controller = new AbortController()
    fetchControllerRef.current = controller
    setLoadState("loading")
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(id)}`, { signal: controller.signal })
      if (controller.signal.aborted || fetchControllerRef.current !== controller) return
      if (response.status === 404) {
        setBoq(null)
        setLoadState("not-found")
        return
      }
      if (!response.ok) throw new Error("Failed to fetch")
      const result = await response.json() as Boq
      if (controller.signal.aborted || fetchControllerRef.current !== controller) return
      setBoq(result)
      setLoadState("loaded")
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return
      setBoq(null)
      setLoadState("error")
    }
  }, [id])

  useEffect(() => {
    if (!legacyReviewMode) return
    router.replace(boqDetailHref(id), { scroll: false })
  }, [id, legacyReviewMode, router])

  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => {
      if (active) void fetchBoq()
    })
    return () => {
      active = false
      fetchControllerRef.current?.abort()
    }
  }, [fetchBoq])

  if (loadState === "loading") {
    return (
      <div className="proto-empty-state boq-detail-state" data-od-id="loading-state" role="status">
        <div className="flex items-center gap-2"><span className="proto-spinner" aria-hidden="true" />Loading BOQ…</div>
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

  return <CanonicalBoqWorkspace key={boq.id} boq={boq} onBoqChange={setBoq} />
}

function CanonicalBoqWorkspace({ boq, onBoqChange }: { boq: Boq; onBoqChange: (next: Boq) => void }) {
  const [edits, setEdits] = useState<EditsMap>({})
  const editsRef = useRef<EditsMap>({})
  const [metadataEdits, setMetadataEdits] = useState<MetadataEdits>({})
  const metadataEditsRef = useRef<MetadataEdits>({})
  const [activeFilter, setActiveFilter] = useState<string>("All")
  const [search, setSearch] = useState("")
  const [catalogMatchTarget, setCatalogMatchTarget] = useState<UnifiedBoqPricedRow | null>(null)
  const [excludeTarget, setExcludeTarget] = useState<UnifiedBoqPricedRow | null>(null)
  const [excludeReason, setExcludeReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [matching, setMatching] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [addingItem, setAddingItem] = useState(false)
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>("items")
  const [pdfPageRequest, setPdfPageRequest] = useState({ page: 1, key: 0 })
  const [invalidDraftKeys, setInvalidDraftKeys] = useState<Set<string>>(new Set())
  const invalidDraftRef = useRef<Set<string>>(new Set())
  const isReadOnly = boq.status === "approved"
  const mutationBusy = saving || approving || matching || deleting || addingItem
  const canonicalRevisionKey = useMemo(() => buildCanonicalRevisionKey(boq), [boq])

  const replaceEdits = useCallback((next: EditsMap) => {
    editsRef.current = next
    setEdits(next)
  }, [])

  const replaceMetadataEdits = useCallback((next: MetadataEdits) => {
    metadataEditsRef.current = next
    setMetadataEdits(next)
  }, [])

  const applyMutationBoq = useCallback((updated: Boq) => {
    const reconciled = reconcileBoqMutation(boq, updated, editsRef.current)
    replaceEdits(reconciled.edits)
    onBoqChange(reconciled.boq)
  }, [boq, onBoqChange, replaceEdits])

  const displayBoq = useMemo<Boq>(() => ({
    ...boq,
    ...metadataEdits,
    sections: boq.sections.map((section, sectionIndex) => ({
      ...section,
      items: section.items.map((item, itemIndex) => mergeItemEdits(item, edits[`${sectionIndex}-${itemIndex}`])),
    })),
  }), [boq, edits, metadataEdits])

  const allUnifiedSections = useMemo(
    () => buildUnifiedBoqSections(displayBoq.sections),
    [displayBoq.sections],
  )
  const unifiedSections = useMemo(() => allUnifiedSections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => {
        if (activeFilter !== "All") {
          const filterType: Record<string, BoqPricedItem["type"]> = { Unit: "unit", "Lump Sum": "lump_sum", Job: "job" }
          if (!isPricedBoqItem(row.item) || row.item.type !== filterType[activeFilter]) return false
        }
        const query = search.trim().toLowerCase()
        if (!query) return true
        return row.item.desc.toLowerCase().includes(query) || (row.item.code ?? "").toLowerCase().includes(query)
      }),
    }))
    .filter((section) => section.rows.length > 0), [activeFilter, allUnifiedSections, search])

  const items = useMemo(() => displayBoq.sections.flatMap((section) => section.items), [displayBoq.sections])
  const grandTotal = useMemo(() => calculateBoqTotals(displayBoq.sections).grandTotal, [displayBoq.sections])
  const catalogReadiness = useMemo(() => getBoqCatalogReadiness(displayBoq), [displayBoq])
  const verification = useMemo(() => buildReviewVerification(displayBoq, {
    vendor: displayBoq.vendor,
    project: displayBoq.project,
    workType: displayBoq.workType,
    date: displayBoq.date,
    items,
  }), [displayBoq, items])
  const blockingIssues = verification.issues.filter((issue) => issue.severity === "blocking")
  const localWarnings = verification.issues.filter((issue) => issue.severity === "warning")
  const editsCount = Object.keys(edits).length
  const metadataEditCount = Object.keys(metadataEdits).length
  const pendingChanges = editsCount + metadataEditCount
  const hasSource = boq.sourceAvailable ?? Boolean(boq.sourceFileName)

  const handleCatalogBoqChange = useCallback((updated: Boq) => {
    applyMutationBoq(updated)
  }, [applyMutationBoq])

  const catalogMatching = useInlineCatalogMatching({
    boq: displayBoq,
    onBoqChange: handleCatalogBoqChange,
    disabled: isReadOnly || mutationBusy,
  })

  const handleAcceptCatalogSuggestion = async (row: UnifiedBoqPricedRow) => {
    if (isReadOnly || mutationBusy) return
    setMatching(true)
    try {
      await catalogMatching.acceptSuggestion(row)
    } finally {
      setMatching(false)
    }
  }

  const handleEdit = useCallback((row: UnifiedBoqPricedRow, field: string, value: string | number | undefined) => {
    if (isReadOnly || mutationBusy) return
    const key = rowEditKey(row)
    const current = editsRef.current
    replaceEdits({ ...current, [key]: { ...current[key], [field]: value } })
  }, [isReadOnly, mutationBusy, replaceEdits])

  const handleFieldChange = useCallback((row: UnifiedBoqPricedRow, field: "code" | "desc" | "unit" | "qty" | "rate" | "type" | "materialCost" | "labourCost", value: string | number | undefined) => {
    if (field === "qty" || field === "rate" || field === "materialCost" || field === "labourCost") {
      const parsed = parseNonNegativeBoqEditValue(String(value))
      if (parsed === undefined) return
      handleEdit(row, field, parsed)
      return
    }
    handleEdit(row, field, value)
  }, [handleEdit])

  const handleAddMissingItem = async () => {
    if (isReadOnly || mutationBusy || boq.sections.length === 0) return
    setAddingItem(true)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionIndex: boq.sections.length - 1, desc: "New missing item" }),
      })
      if (!response.ok) throw new Error(await readError(response, "The missing item could not be added."))
      applyMutationBoq(await response.json() as Boq)
      toast.success("Missing item added as a user-entered unpriced row")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The missing item could not be added.")
    } finally {
      setAddingItem(false)
    }
  }

  const handleIncludeOptional = async (row: UnifiedBoqPricedRow) => {
    if (isReadOnly || mutationBusy || !row.item.optional || !row.item.excludedFromTotal) return
    setMatching(true)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: [{ sectionIndex: row.sectionIndex, items: [{ ...getBoqItemRequestIdentity(row.item), excludedFromTotal: false }] }] }),
      })
      if (!response.ok) throw new Error(await readError(response, "The optional item could not be included."))
      applyMutationBoq(await response.json() as Boq)
      toast.success("Optional item included in the BOQ total")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The optional item could not be included.")
    } finally {
      setMatching(false)
    }
  }

  const handleMetadataChange = useCallback((field: MetadataField, value: string) => {
    if (isReadOnly || mutationBusy) return
    const current = metadataEditsRef.current
    if (value === boq[field]) {
      const remaining = { ...current }
      delete remaining[field]
      replaceMetadataEdits(remaining)
      return
    }
    replaceMetadataEdits({
      ...current,
      [field]: field === "workType" ? value as WorkType : value,
    })
  }, [boq, isReadOnly, mutationBusy, replaceMetadataEdits])

  const handleComponentDraftValidityChange = useCallback((key: string, isInvalid: boolean) => {
    const next = new Set(invalidDraftRef.current)
    if (isInvalid) {
      next.add(key)
    } else {
      next.delete(key)
    }
    invalidDraftRef.current = next
    setInvalidDraftKeys(next)
  }, [])

  const handleSaveAll = async () => {
    if (isReadOnly || mutationBusy) return
    if (invalidDraftRef.current.size > 0) {
      toast.error("Component costs contain invalid drafts. Fix them before saving.")
      return
    }
    const editSnapshot = editsRef.current
    const metadataSnapshot = metadataEditsRef.current
    const keys = Object.keys(editSnapshot)
    if (keys.length === 0 && Object.keys(metadataSnapshot).length === 0) {
      toast.info("No changes to save")
      return
    }

    const updates = new Map<number, { sectionIndex: number; items: Array<Record<string, string | number | undefined>> }>()
    const linkedCanonicalEdits: Array<{ item: BoqItem; standardId: string }> = []
    for (const key of keys) {
      const [sectionIndex, itemIndex] = key.split("-").map(Number)
      const item = boq.sections[sectionIndex]?.items[itemIndex]
      const edit = editSnapshot[key]
      if (!item || !edit) continue
      const group = updates.get(sectionIndex) ?? { sectionIndex, items: [] }
      group.items.push({ ...getBoqItemRequestIdentity(item), ...edit })
      updates.set(sectionIndex, group)
      if (isPricedBoqItem(item) && item.stdId && ((edit.desc !== undefined && edit.desc !== item.desc) || (edit.unit !== undefined && edit.unit !== item.unit))) {
        linkedCanonicalEdits.push({ item, standardId: item.stdId })
      }
    }

    if (linkedCanonicalEdits.length > 0) {
      const labels = linkedCanonicalEdits.map(({ item }) => `• ${item.stdMatch || item.desc}`).join("\n")
      const confirmed = window.confirm(
        `This edit changes a shared catalog item and will update its canonical description or unit on linked BOQ rows. Quantities, rates, and source provenance stay unchanged.\n\n${labels}\n\nContinue?`,
      )
      if (!confirmed) return
    }

    setSaving(true)
    try {
      if (Object.keys(metadataSnapshot).length > 0) {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(metadataSnapshot),
        })
        if (!response.ok) throw new Error(await readError(response, "Failed to save BOQ details"))
        applyMutationBoq(await response.json() as Boq)
        replaceMetadataEdits({})
      }

      let synced = 0
      if (keys.length > 0) {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/items`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: Array.from(updates.values()) }),
        })
        if (!response.ok) throw new Error(await readError(response, "Failed to save changes"))
        const result = await response.json() as { boq?: Boq; sync?: { affectedItems?: number } } & Boq
        applyMutationBoq(result.boq ?? result)
        replaceEdits({})
        synced = result.sync?.affectedItems ?? 0
      }
      toast.success(synced > 0 ? `All changes saved · synced ${synced} linked item${synced === 1 ? "" : "s"}` : "All changes saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save changes")
    } finally {
      setSaving(false)
    }
  }

  const handleApprove = async () => {
    if (isReadOnly || mutationBusy) return
    if (invalidDraftRef.current.size > 0) return void toast.error("Component costs contain invalid drafts. Fix them before approving.")
    if (pendingChanges > 0) return void toast.error("Save pending changes before approving")
    if (verification.hasBlockingIssues) return void toast.error("Resolve the review blockers before approving")
    if (requireCatalogReadiness && catalogReadiness.blocking > 0) return void toast.error("Resolve catalog matching before approving")
    setApproving(true)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      })
      if (!response.ok) throw new Error(await readError(response, "Failed to approve BOQ"))
      applyMutationBoq(await response.json() as Boq)
      toast.success("BOQ approved and linked to the Standard Catalog")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to approve BOQ")
    } finally {
      setApproving(false)
    }
  }

  const reloadAfterManualMatch = async (_standardId: string, standardDescription: string) => {
    setMatching(true)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`)
      if (!response.ok) throw new Error(await readError(response, "The updated BOQ could not be loaded"))
      applyMutationBoq(await response.json() as Boq)
      setCatalogMatchTarget(null)
      toast.success(`Matched to: “${standardDescription}”`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The catalog match could not be applied")
    } finally {
      setMatching(false)
    }
  }

  const handleExclude = async () => {
    if (!excludeTarget || !excludeReason.trim() || isReadOnly || mutationBusy) return
    setMatching(true)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [{
            sectionIndex: excludeTarget.sectionIndex,
            items: [{
              ...getBoqItemRequestIdentity(excludeTarget.item),
              stdStatus: "excluded",
              stdExclusionReason: excludeReason.trim(),
            }],
          }],
        }),
      })
      if (!response.ok) throw new Error(await readError(response, "The item could not be excluded"))
      const result = await response.json() as { boq?: Boq } & Boq
      applyMutationBoq(result.boq ?? result)
      setExcludeTarget(null)
      setExcludeReason("")
      toast.success("Item excluded from catalog matching")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The item could not be excluded")
    } finally {
      setMatching(false)
    }
  }

  const handleExportCsv = () => {
    const csv = buildBoqCsv(displayBoq)
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${boq.project || "boq"}-detail.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success("CSV exported")
  }

  const handleDeleteBoq = async () => {
    if (mutationBusy) return
    const confirmation = window.prompt(`Delete the entire BOQ and source PDF? Type “${boq.project}” to confirm.`)
    if (confirmation !== boq.project) return
    setDeleting(true)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, { method: "DELETE" })
      if (!response.ok) throw new Error(await readError(response, "The BOQ could not be deleted"))
      window.location.assign("/boqs")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The BOQ could not be deleted")
      setDeleting(false)
    }
  }

  return (
    <div className="review-embedded boq-unified-workspace" data-od-id="boq-detail">
      <div className="review-panel">
        <header className="review-header boq-unified-header" data-od-id="detail-header">
          <div className="review-header-title">
            <Link href="/boqs" className="boq-back-link"><ChevronLeft aria-hidden="true" />Back to BOQs</Link>
            <div className="boq-unified-title">
              <strong>{boq.project || "Untitled BOQ"}</strong>
              <span>{boq.vendor}</span>
            </div>
            <ProtoBadge status={boq.status} />
            {isReadOnly ? <span className="boq-readonly-note"><Lock aria-hidden="true" />Approved · read only</span> : null}
          </div>
          <div className="review-header-actions boq-unified-actions">
            {hasSource || boq.activeExtractionRunId ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setRightPaneMode(rightPaneMode === "items" ? "extraction" : "items")} disabled={mutationBusy} aria-controls={rightPaneMode === "items" ? "boq-extraction-panel" : "boq-items-panel"}>
                {rightPaneMode === "items" ? <><Sparkles aria-hidden="true" />Extraction review</> : <><FileSearch aria-hidden="true" />BOQ items</>}
              </Button>
            ) : null}
            {!isReadOnly ? (
              <>
                <Button type="button" variant="outline" size="sm" onClick={() => void handleSaveAll()} disabled={mutationBusy || invalidDraftKeys.size > 0}>
                  {saving ? <Loader2 className="animate-spin" /> : <Save aria-hidden="true" />}Save draft
                </Button>
                <Button type="button" size="sm" onClick={() => void handleApprove()} disabled={mutationBusy || invalidDraftKeys.size > 0 || pendingChanges > 0 || verification.hasBlockingIssues || (requireCatalogReadiness && catalogReadiness.blocking > 0)}>
                  {approving ? <Loader2 className="animate-spin" /> : <Check aria-hidden="true" />}Approve BOQ
                </Button>
              </>
            ) : null}
            <details className="boq-overflow-menu">
              <summary className="btn btn-ghost btn-sm" aria-label="More BOQ actions"><MoreHorizontal aria-hidden="true" /><span className="sr-only">More BOQ actions</span></summary>
              <div className="boq-overflow-menu-content" role="menu">
                <button type="button" role="menuitem" onClick={handleExportCsv}><FileDown aria-hidden="true" />Export CSV</button>
                <button type="button" role="menuitem" onClick={() => window.print()}><Printer aria-hidden="true" />Print / download</button>
                <button type="button" role="menuitem" className="text-destructive" disabled={mutationBusy} onClick={() => void handleDeleteBoq()}><Trash2 aria-hidden="true" />Delete BOQ</button>
              </div>
            </details>
          </div>
        </header>

        <ReviewWorkspace
          hasSource={hasSource}
          sourceFileName={boq.sourceFileName || "source.pdf"}
          pdf={hasSource ? (
            <PdfReviewViewer
              sourceUrl={`/api/boqs/${encodeURIComponent(boq.id)}/source`}
              sourceFileName={boq.sourceFileName || "source.pdf"}
              resetKey={boq.id}
              requestedPage={pdfPageRequest.page}
              requestedPageKey={pdfPageRequest.key}
            />
          ) : null}
        >
          <div className="boq-items-mode" id="boq-items-panel" hidden={rightPaneMode !== "items"}>
          <div className="review-metadata">
            <h2 className="text-sm font-medium mb-3">BOQ Details</h2>
            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Vendor" value={displayBoq.vendor} field="vendor" disabled={isReadOnly || mutationBusy} confidence={confidenceLabel(boq.metadataConfidence?.vendor)} onChange={handleMetadataChange} />
              <MetaField label="Project" value={displayBoq.project} field="project" disabled={isReadOnly || mutationBusy} confidence={confidenceLabel(boq.metadataConfidence?.project)} onChange={handleMetadataChange} />
              <MetaField label="Work Type" value={displayBoq.workType} field="workType" type="select" options={["Unclassified", "Structural", "MEP", "Finishing"]} disabled={isReadOnly || mutationBusy} confidence={confidenceLabel(boq.metadataConfidence?.workType)} onChange={handleMetadataChange} />
              <MetaField label="Document Date" value={displayBoq.date} field="date" type="date" disabled={isReadOnly || mutationBusy} confidence={confidenceLabel(boq.metadataConfidence?.date)} onChange={handleMetadataChange} />
            </div>
          </div>

          {boq.extractionWarnings?.length ? (
            <div className="review-warning-list" role="status">
              <strong>Document extraction notes</strong>
              {boq.extractionWarnings.map((warning, index) => <span key={`${warning.code}-${index}`}>{warning.message}</span>)}
            </div>
          ) : null}

          <div className="boq-detail-toolbar" data-od-id="toolbar">
            <div className="search-wrap">
              <Search aria-hidden="true" />
              <Input placeholder="Search items…" value={search} onChange={(event) => setSearch(event.target.value)} className="proto-input" />
            </div>
            <div className="boq-detail-filters" aria-label="Filter BOQ items">
              {FILTERS.map((filter) => (
                <button type="button" key={filter} onClick={() => setActiveFilter(filter)} aria-pressed={activeFilter === filter} className={`filter-chip ${activeFilter === filter ? "active" : ""}`}>{filter}</button>
              ))}
            </div>
          </div>

          <div className="review-items-heading">
            <span className="text-sm font-medium">Parsed Items · {items.length} line items</span>
            <div className="review-items-heading-actions">
              <span className="font-mono text-sm">Grand Total: ฿{grandTotal.toLocaleString()}</span>
              {!isReadOnly ? <Button type="button" variant="outline" size="sm" onClick={() => void handleAddMissingItem()} disabled={mutationBusy || boq.sections.length === 0} data-od-id="add-missing-item">{addingItem ? <Loader2 className="animate-spin" /> : <Plus aria-hidden="true" />}Add missing item</Button> : null}
            </div>
          </div>
          {unifiedSections.length > 0 ? (
            <UnifiedBoqItemsTable
              sections={unifiedSections}
              readOnly={isReadOnly}
              disabled={isReadOnly || mutationBusy}
              catalogState={catalogMatching.rowState}
              onFieldChange={handleFieldChange}
              onAcceptSuggestion={(row) => { void handleAcceptCatalogSuggestion(row) }}
              onAiSuggest={(row) => { void catalogMatching.suggestWithAi(row) }}
              onDismissSuggestion={catalogMatching.dismissSuggestion}
              onFindMatch={setCatalogMatchTarget}
              onExclude={(row) => { setExcludeTarget(row); setExcludeReason("") }}
              onIncludeOptional={(row) => { void handleIncludeOptional(row) }}
              onClearCatalogError={catalogMatching.clearRowError}
              onComponentDraftValidityChange={handleComponentDraftValidityChange}
            />
          ) : (
            <div className="proto-empty-state boq-filter-empty"><p>No items match your filter</p></div>
          )}

          {requireCatalogReadiness ? (
            <div className="rounded-lg border border-accent/25 bg-accent/5 p-3 mt-3" data-od-id="catalog-readiness">
              <div className="flex items-center justify-between gap-3 text-sm"><strong>Catalog readiness</strong><span className="font-mono">{catalogReadiness.resolved}/{catalogReadiness.total} resolved</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full bg-accent" style={{ width: `${catalogReadiness.total ? (catalogReadiness.resolved / catalogReadiness.total) * 100 : 100}%` }} /></div>
              <p className="mt-2 text-xs text-muted-foreground">Match an existing item, create a catalog entry, or exclude a one-off line with a reason before approval.</p>
            </div>
          ) : null}

          {localWarnings.length ? (
            <div className="review-warning-list review-local-warnings mt-3" role="status"><strong>Review recommended</strong>{localWarnings.map((warning, index) => <span key={`${warning.code}-${index}`}>{warning.message}</span>)}</div>
          ) : null}
          {blockingIssues.length ? (
            <div className="review-blockers mt-3" role="alert"><strong>Resolve before approval</strong><ul>{blockingIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></div>
          ) : null}
          </div>
          <div className="boq-extraction-mode" id="boq-extraction-panel" hidden={rightPaneMode !== "extraction"}>
            <ExtractionReview
              boq={boq}
              canonicalRevisionKey={canonicalRevisionKey}
              readOnly={isReadOnly}
              mutationBlockedReason={invalidDraftKeys.size > 0 ? "Component costs contain invalid drafts. Fix them before applying extraction corrections." : pendingChanges > 0 ? "You have unsaved BOQ item or detail edits. Use Save draft before applying extraction corrections." : undefined}
              sourceAvailable={hasSource}
              onBoqChange={applyMutationBoq}
              onNavigateToPage={(page) => setPdfPageRequest((current) => ({ page, key: current.key + 1 }))}
            />
          </div>
        </ReviewWorkspace>
      </div>

      {catalogMatchTarget ? (
        <CatalogMatchModal
          itemDesc={catalogMatchTarget.item.desc}
          itemUnit={catalogMatchTarget.item.unit}
          itemCode={catalogMatchTarget.item.code}
          sourceProject={boq.project}
          sourceVendor={boq.vendor}
          matchContext={{ boqId: boq.id, sectionIndex: catalogMatchTarget.sectionIndex, ...getBoqItemRequestIdentity(catalogMatchTarget.item) }}
          onMatch={reloadAfterManualMatch}
          onClose={() => setCatalogMatchTarget(null)}
        />
      ) : null}

      <Dialog open={Boolean(excludeTarget)} onOpenChange={(open) => { if (!open && !matching) { setExcludeTarget(null); setExcludeReason("") } }}>
        <DialogContent showCloseButton={!matching}>
          <DialogHeader>
            <DialogTitle>Exclude from catalog matching</DialogTitle>
            <DialogDescription>Add a reason so reviewers understand why {excludeTarget?.item.desc ?? "this item"} should not use catalog pricing.</DialogDescription>
          </DialogHeader>
          <Input value={excludeReason} onChange={(event) => setExcludeReason(event.target.value)} placeholder="Reason this line should not use catalog pricing" aria-label={`Exclusion reason for ${excludeTarget?.item.desc ?? "item"}`} disabled={matching} autoFocus />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={matching} onClick={() => { setExcludeTarget(null); setExcludeReason("") }}>Cancel</Button>
            <Button type="button" disabled={!excludeReason.trim() || matching} onClick={() => void handleExclude()}>{matching ? <Loader2 className="animate-spin" /> : null}Exclude item</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}

function MetaField({
  label,
  value,
  field,
  onChange,
  disabled,
  confidence,
  type = "text",
  options,
}: {
  label: string
  value: string
  field: MetadataField
  onChange: (field: MetadataField, value: string) => void
  disabled: boolean
  confidence: string | null
  type?: "text" | "select" | "date"
  options?: WorkType[]
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const commit = () => {
    if (draft !== value) onChange(field, draft)
    setEditing(false)
  }

  return (
    <div className="space-y-1" data-meta={field}>
      <div className="review-field-label">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {confidence ? <small>{confidence}</small> : null}
          {!disabled && !editing ? <button type="button" className="boq-meta-edit" onClick={() => { setDraft(value); setEditing(true) }}>Edit</button> : null}
        </span>
      </div>
      {editing ? (
        type === "select" ? (
          <select value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm" autoFocus>
            {options?.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : (
          <Input type={type === "date" ? "date" : "text"} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") setEditing(false) }} autoFocus />
        )
      ) : <div className="boq-meta-readonly-value">{value || "—"}</div>}
    </div>
  )
}
