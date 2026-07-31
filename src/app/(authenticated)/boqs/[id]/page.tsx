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
import { ExtractionWarnings } from "@/components/extraction-warnings"
import { ProtoBadge } from "@/components/proto-badge"
import { ReviewWorkspace } from "@/components/review-workspace"
import dynamic from "next/dynamic"
// pdfjs-dist references browser-only APIs (DOMMatrix) at module evaluation, so the
// viewer must never be server-rendered; load it client-side only.
const PdfReviewViewer = dynamic(() => import("@/components/pdf-review-viewer").then((m) => m.PdfReviewViewer), {
  ssr: false,
  loading: () => <div className="pdf-review-loading" role="status" aria-label="Loading PDF viewer">…</div>,
})
import { UnifiedBoqItemsTable } from "@/components/unified-boq-items-table"
import { useInlineCatalogMatching } from "@/components/use-inline-catalog-matching"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import {
  applyBoqDetailEdits,
  clearBoqDetailDraftSnapshot,
  compareBoqUpdatedAt,
  reconcileBoqMutation,
  resolveBoqDetailEdits,
  restoreBoqDetailDraft,
  takeBoqDetailDraft,
  type BoqDetailEdits,
} from "@/lib/boq-detail-state"
import { getBoqItemIdentityKey, getBoqItemRequestIdentity, resolveBoqItemIdentityKey } from "@/lib/boq-item-identity"
import { calculateBoqTotals, isPricedBoqItem, parseNonNegativeBoqEditValue } from "@/lib/boq-pricing"
import { boqDetailHref, isBoqReviewMode } from "@/lib/boq-review-route"
import { buildCanonicalRevisionKey, buildReviewVerification } from "@/lib/boq-review-state"
import type { Boq, BoqItem, WorkType } from "@/lib/boq-schema"
import {
  buildUnifiedBoqSections,
  type UnifiedBoqPricedRow,
} from "@/lib/boq-unified-rows"
import { createSerialTaskQueue } from "@/lib/serial-task-queue"
import { combineUnitOptions } from "@/lib/units"
import { addWorkspaceUnit, loadWorkspaceCustomUnits } from "@/lib/workspace-units-client"

type EditsMap = BoqDetailEdits
type LoadState = "loading" | "loaded" | "not-found" | "error"
type MetadataField = "vendor" | "project" | "workType" | "date"
type MetadataEdits = Partial<Pick<Boq, MetadataField>>
type RightPaneMode = "items" | "extraction"

const requireCatalogReadiness = true

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

type StashedDelete = { identityKey: string; draft?: BoqDetailEdits[string] }

function CanonicalBoqWorkspace({ boq, onBoqChange }: { boq: Boq; onBoqChange: (next: Boq) => void }) {
  const [edits, setEdits] = useState<EditsMap>({})
  const editsRef = useRef<EditsMap>({})
  const [metadataEdits, setMetadataEdits] = useState<MetadataEdits>({})
  const metadataEditsRef = useRef<MetadataEdits>({})
  const [search, setSearch] = useState("")
  const [catalogMatchTarget, setCatalogMatchTarget] = useState<UnifiedBoqPricedRow | null>(null)
  const [excludeTarget, setExcludeTarget] = useState<UnifiedBoqPricedRow | null>(null)
  const [excludeReason, setExcludeReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [addingItem, setAddingItem] = useState(false)
  const [catalogModalBusy, setCatalogModalBusy] = useState(false)
  const [excludeBusy, setExcludeBusy] = useState(false)
  const [includingItemKeys, setIncludingItemKeys] = useState<Set<string>>(new Set())
  const [deletingBoq, setDeletingBoq] = useState(false)
  const [activeCanonicalMutations, setActiveCanonicalMutations] = useState(0)
  const activeCanonicalMutationsRef = useRef(0)
  const mutationEpochRef = useRef(0)
  const mutationOverlapRef = useRef(false)
  const canonicalRefreshNeededRef = useRef(false)
  const canonicalRefreshRef = useRef<Promise<void> | null>(null)
  // Latest-ref indirection so an overtaken refresh can await its own
  // replacement without a self-referential call the compiler cannot preserve
  // as manual memoization.
  const refreshCanonicalAfterIdleRef = useRef<() => Promise<void>>(async () => {})
  // Render-safe mirror of whether a canonical refresh is in flight, so the
  // approval gate can block during a refresh without reading a ref in render.
  const [canonicalRefreshInFlight, setCanonicalRefreshInFlight] = useState(false)
  const approvalBarrierRef = useRef(false)
  const [approveWarningOpen, setApproveWarningOpen] = useState(false)
  const approveCancelRef = useRef<HTMLButtonElement>(null)
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>("items")
  const [pdfEvidenceFocus, setPdfEvidenceFocus] = useState<{ page: number; key: number }>({ page: 1, key: 0 })
  const [invalidDraftKeys, setInvalidDraftKeys] = useState<Set<string>>(new Set())
  const invalidDraftRef = useRef<Set<string>>(new Set())
  const [customUnits, setCustomUnits] = useState<string[]>([])
  const [workspaceUnitsError, setWorkspaceUnitsError] = useState<string | null>(null)
  const [pendingDeletes, setPendingDeletes] = useState<StashedDelete[]>([])
  const boqRef = useRef(boq)
  const units = useMemo(() => combineUnitOptions(customUnits), [customUnits])
  const isReadOnly = boq.status === "approved"
  const canonicalRevisionKey = useMemo(() => buildCanonicalRevisionKey(boq), [boq])

  useEffect(() => {
    boqRef.current = boq
  }, [boq])

  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspaceCustomUnits(fetch, controller.signal).then((loaded) => {
      setCustomUnits(loaded)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return
      setWorkspaceUnitsError("Workspace units could not be loaded. Standard units are still available.")
    })
    return () => controller.abort()
  }, [])

  const replaceEdits = useCallback((next: EditsMap) => {
    editsRef.current = next
    setEdits(next)
  }, [])

  const replaceMetadataEdits = useCallback((next: MetadataEdits) => {
    metadataEditsRef.current = next
    setMetadataEdits(next)
  }, [])

  const applyMutationBoq = useCallback((incoming: Boq, { force = false }: { force?: boolean } = {}) => {
    if (!force) {
      const comparison = compareBoqUpdatedAt(boqRef.current, incoming)
      if (comparison === "incoming-older" || comparison === "invalid") {
        canonicalRefreshNeededRef.current = true
        return
      }
      if (comparison === "equal") {
        if (JSON.stringify(boqRef.current) === JSON.stringify(incoming)) return
        canonicalRefreshNeededRef.current = true
        return
      }
    }
    const reconciled = reconcileBoqMutation(boqRef.current, incoming, editsRef.current)
    boqRef.current = reconciled.boq
    replaceEdits(reconciled.edits)
    onBoqChange(reconciled.boq)
  }, [onBoqChange, replaceEdits])

  const refreshCanonicalAfterIdle = useCallback(async (): Promise<void> => {
    if (canonicalRefreshRef.current) return canonicalRefreshRef.current
    const epoch = mutationEpochRef.current
    let ownedTask: Promise<void> | null = null
    const runRefresh = async (): Promise<void> => {
      let refreshWasOvertaken = false
      try {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}`)
        if (!response.ok) throw new Error("The latest BOQ could not be refreshed.")
        const result = await response.json() as Boq
        if (activeCanonicalMutationsRef.current > 0 || mutationEpochRef.current !== epoch) {
          refreshWasOvertaken = true
          canonicalRefreshNeededRef.current = true
          return
        }
        applyMutationBoq(result, { force: true })
        mutationOverlapRef.current = false
        canonicalRefreshNeededRef.current = false
      } catch {
        if (activeCanonicalMutationsRef.current > 0 || mutationEpochRef.current !== epoch) {
          refreshWasOvertaken = true
        }
        toast.error("The latest BOQ could not be refreshed. Your edits are preserved.")
      } finally {
        if (canonicalRefreshRef.current === ownedTask) {
          canonicalRefreshRef.current = null
          setCanonicalRefreshInFlight(false)
        }
        if (refreshWasOvertaken && activeCanonicalMutationsRef.current === 0 && canonicalRefreshNeededRef.current) {
          // Await the replacement AFTER clearing the old promise (via the
          // latest-ref indirection) so an overtaken refresh cannot resolve until
          // its authoritative replacement completes.
          await refreshCanonicalAfterIdleRef.current()
        }
      }
    }
    ownedTask = runRefresh()
    canonicalRefreshRef.current = ownedTask
    setCanonicalRefreshInFlight(true)
    return ownedTask
  }, [applyMutationBoq])

  // Keep the latest-ref indirection in sync so the overtaken refresh always
  // awaits the current replacement implementation.
  useEffect(() => {
    refreshCanonicalAfterIdleRef.current = refreshCanonicalAfterIdle
  }, [refreshCanonicalAfterIdle])

  const runCanonicalMutation = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T> => {
      if (activeCanonicalMutationsRef.current > 0) {
        mutationOverlapRef.current = true
      }
      activeCanonicalMutationsRef.current += 1
      mutationEpochRef.current += 1
      setActiveCanonicalMutations((count) => count + 1)
      try {
        return await work()
      } finally {
        activeCanonicalMutationsRef.current -= 1
        setActiveCanonicalMutations((count) => count - 1)
        if (
          activeCanonicalMutationsRef.current === 0
          && (mutationOverlapRef.current || canonicalRefreshNeededRef.current)
        ) {
          // Await the authoritative refresh so the serial delete queue (and any
          // other caller) cannot start the next task before it fully completes.
          await refreshCanonicalAfterIdle()
        }
      }
    },
    [refreshCanonicalAfterIdle],
  )

  // `activeCanonicalMutations` mirrors the ref so React re-renders whenever an
  // overlap-safe canonical mutation starts or settles, keeping derived UI in
  // sync with the latest published canonical state.
  void activeCanonicalMutations

  const deleteQueueRef = useRef(createSerialTaskQueue())
  const commitDeleteRef = useRef<(stash: StashedDelete) => Promise<void>>(async () => {})
  useEffect(() => {
    commitDeleteRef.current = async (stash) => {
      try {
        // Resolve the latest canonical location by identity at commit time so
        // earlier section/item indices never target a different row.
        const resolution = resolveBoqItemIdentityKey(
          boqRef.current.sections,
          stash.identityKey,
        )
        if (resolution.status !== "found") {
          throw new Error("The item no longer has a unique location in this BOQ.")
        }
        const response = await fetch(
          `/api/boqs/${encodeURIComponent(boqRef.current.id)}/items`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sectionIndex: resolution.location.sectionIndex,
              ...getBoqItemRequestIdentity(resolution.location.item),
            }),
          },
        )
        if (!response.ok) throw new Error(await readError(response, "The item could not be deleted."))
        // Apply the returned BOQ through stable reconciliation. Unrelated drafts
        // are preserved; the stashed draft is intentionally discarded.
        applyMutationBoq(await response.json() as Boq)
        // Success: the canonical row is gone. Drop the optimistic stash so
        // pendingDeletes stays accurate.
        setPendingDeletes((prev) => prev.filter(
          (pending) => pending.identityKey !== stash.identityKey,
        ))
      } catch (error) {
        // Failure (identity lost or server error): restore the exact row draft
        // and reveal the canonical row again. Unrelated drafts stay intact.
        replaceEdits(restoreBoqDetailDraft(editsRef.current, stash.identityKey, stash.draft))
        setPendingDeletes((prev) => prev.filter(
          (pending) => pending.identityKey !== stash.identityKey,
        ))
        toast.error(error instanceof Error ? error.message : "The item could not be deleted.")
      }
    }
  }, [applyMutationBoq, replaceEdits])

  const displayedItems = useMemo(
    () => applyBoqDetailEdits(boq, edits),
    [boq, edits],
  )

  const displayBoq = useMemo<Boq>(() => ({
    ...displayedItems.boq,
    ...metadataEdits,
  }), [displayedItems.boq, metadataEdits])

  const allUnifiedSections = useMemo(() => {
    const built = buildUnifiedBoqSections(displayBoq.sections)
    if (pendingDeletes.length === 0) return built
    const hiddenIdentities = new Set(pendingDeletes.map((pending) => pending.identityKey))
    return built.map((section) => ({
      ...section,
      rows: section.rows.filter((row) => !(row.identityKey && hiddenIdentities.has(row.identityKey))),
    }))
  }, [displayBoq.sections, pendingDeletes])
  const unifiedSections = useMemo(() => {
    const query = search.trim().toLowerCase()
    return allUnifiedSections
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) => {
          if (!query) return true
          return row.item.desc.toLowerCase().includes(query) || (row.item.code ?? "").toLowerCase().includes(query)
        }),
      }))
      .filter((section) => section.rows.length > 0)
  }, [allUnifiedSections, search])

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
    disabled: isReadOnly || approving,
  })

  const handleAcceptCatalogSuggestion = async (row: UnifiedBoqPricedRow) => {
    if (isReadOnly || approving || approvalBarrierRef.current) return
    await runCanonicalMutation(() => catalogMatching.acceptSuggestion(row)).catch(() => {
      // The inline catalog controller surfaces its own per-row errors.
    })
  }

  const handleAiSuggest = async (row: UnifiedBoqPricedRow) => {
    if (isReadOnly || approving || approvalBarrierRef.current) return
    await runCanonicalMutation(() => catalogMatching.suggestWithAi(row)).catch(() => {
      // The inline catalog controller surfaces its own per-row errors.
    })
  }

  const handleEdit = useCallback((row: UnifiedBoqPricedRow, field: string, value: string | number | undefined) => {
    if (isReadOnly || saving || approving || approvalBarrierRef.current) return
    const identityKey = getBoqItemIdentityKey(row.item)
    if (!identityKey || row.identityIssue) {
      toast.error("This item has no unique identity and cannot be edited.")
      return
    }
    const current = editsRef.current
    replaceEdits({
      ...current,
      [identityKey]: { ...current[identityKey], [field]: value },
    })
  }, [isReadOnly, saving, approving, replaceEdits])

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
    if (isReadOnly || addingItem || approving || approvalBarrierRef.current) return
    if (boq.sections.length === 0) return
    setAddingItem(true)
    try {
      await runCanonicalMutation(async () => {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sectionIndex: boqRef.current.sections.length - 1, desc: "New missing item" }),
        })
        if (!response.ok) throw new Error(await readError(response, "The missing item could not be added."))
        applyMutationBoq(await response.json() as Boq)
        toast.success("Missing item added as a user-entered unpriced row")
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The missing item could not be added.")
    } finally {
      setAddingItem(false)
    }
  }

  const handleIncludeOptional = async (row: UnifiedBoqPricedRow) => {
    if (isReadOnly || approving || approvalBarrierRef.current) return
    if (!row.item.optional || !row.item.excludedFromTotal) return
    const identityKey = row.identityKey ?? getBoqItemIdentityKey(row.item)
    if (!identityKey || row.identityIssue) {
      toast.error("This item has no unique identity and cannot be edited.")
      return
    }
    if (includingItemKeys.has(identityKey)) return
    setIncludingItemKeys((prev) => {
      const next = new Set(prev)
      next.add(identityKey)
      return next
    })
    try {
      await runCanonicalMutation(async () => {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}/items`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ sectionIndex: row.sectionIndex, items: [{ ...getBoqItemRequestIdentity(row.item), excludedFromTotal: false }] }] }),
        })
        if (!response.ok) throw new Error(await readError(response, "The optional item could not be included."))
        applyMutationBoq(await response.json() as Boq)
        toast.success("Optional item included in the BOQ total")
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The optional item could not be included.")
    } finally {
      setIncludingItemKeys((prev) => {
        const next = new Set(prev)
        next.delete(identityKey)
        return next
      })
    }
  }

  const handleDelete = useCallback((row: UnifiedBoqPricedRow) => {
    if (isReadOnly || approving || approvalBarrierRef.current) return
    const identityKey = row.identityKey ?? getBoqItemIdentityKey(row.item)
    if (!identityKey || row.identityIssue) return
    // Stash only the deleted row's draft so it can be restored verbatim on Undo
    // or a failed commit. Unrelated drafts are never touched.
    const { edits: remainingEdits, draft } = takeBoqDetailDraft(editsRef.current, identityKey)
    replaceEdits(remainingEdits)
    const stash: StashedDelete = { identityKey, draft }
    setPendingDeletes((prev) => [...prev, stash])
    const toastId = `delete-${identityKey}`
    let undone = false
    let committed = false
    const finalize = () => {
      if (undone || committed) return
      committed = true
      void deleteQueueRef.current
        .enqueue(() => runCanonicalMutation(() => commitDeleteRef.current(stash)))
        .catch(() => undefined)
    }
    toast("Line item deleted", {
      id: toastId,
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          undone = true
          setPendingDeletes((prev) => prev.filter(
            (pending) => pending.identityKey !== stash.identityKey,
          ))
          replaceEdits(restoreBoqDetailDraft(editsRef.current, stash.identityKey, stash.draft))
          toast.dismiss(toastId)
        },
      },
      onAutoClose: finalize,
      onDismiss: finalize,
    })
  }, [isReadOnly, approving, replaceEdits, runCanonicalMutation])

  const handleMetadataChange = useCallback((field: MetadataField, value: string) => {
    if (isReadOnly || saving || approving || approvalBarrierRef.current) return
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
  }, [boq, isReadOnly, saving, approving, replaceMetadataEdits])

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
    if (isReadOnly || saving || approving || approvalBarrierRef.current) return
    if (invalidDraftRef.current.size > 0) {
      toast.error("Component costs contain invalid drafts. Fix them before saving.")
      return
    }
    const editSnapshot = editsRef.current
    const metadataSnapshot = metadataEditsRef.current
    const resolution = resolveBoqDetailEdits(boqRef.current, editSnapshot)
    if (resolution.issues.length > 0) {
      toast.error("Some unsaved items no longer have a unique BOQ identity.")
      return
    }
    if (resolution.resolved.length === 0 && Object.keys(metadataSnapshot).length === 0) {
      toast.info("No changes to save")
      return
    }

    const updates = new Map<number, { sectionIndex: number; items: Array<Record<string, string | number | undefined>> }>()
    const linkedCanonicalEdits: Array<{ item: BoqItem; standardId: string }> = []
    for (const resolved of resolution.resolved) {
      const group = updates.get(resolved.sectionIndex) ?? { sectionIndex: resolved.sectionIndex, items: [] }
      group.items.push({ ...getBoqItemRequestIdentity(resolved.item), ...resolved.edit })
      updates.set(resolved.sectionIndex, group)
      if (isPricedBoqItem(resolved.item) && resolved.item.stdId && ((resolved.edit.desc !== undefined && resolved.edit.desc !== resolved.item.desc) || (resolved.edit.unit !== undefined && resolved.edit.unit !== resolved.item.unit))) {
        linkedCanonicalEdits.push({ item: resolved.item, standardId: resolved.item.stdId })
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
      await runCanonicalMutation(async () => {
        if (Object.keys(metadataSnapshot).length > 0) {
          const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(metadataSnapshot),
          })
          if (!response.ok) throw new Error(await readError(response, "Failed to save BOQ details"))
          applyMutationBoq(await response.json() as Boq)
        }

        let synced = 0
        if (resolution.resolved.length > 0) {
          const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}/items`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updates: Array.from(updates.values()) }),
          })
          if (!response.ok) throw new Error(await readError(response, "Failed to save changes"))
          const result = await response.json() as { boq?: Boq; sync?: { affectedItems?: number } } & Boq
          applyMutationBoq(result.boq ?? result)
          synced = result.sync?.affectedItems ?? 0
        }
        // Common success boundary: clear only the captured snapshot drafts so
        // edits restored or created during the in-flight Save (e.g. an Undo)
        // survive. Clearing the snapshot — not the whole current draft — keeps
        // retry idempotent and preserves unrelated work.
        replaceMetadataEdits(
          Object.fromEntries(
            Object.entries(metadataEditsRef.current).filter(
              ([field]) => !(field in metadataSnapshot),
            ),
          ) as MetadataEdits,
        )
        replaceEdits(clearBoqDetailDraftSnapshot(editsRef.current, editSnapshot))
        toast.success(synced > 0 ? `All changes saved · synced ${synced} linked item${synced === 1 ? "" : "s"}` : "All changes saved")
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save changes")
    } finally {
      setSaving(false)
    }
  }

  // Approval is for the saved version. `computeApprovalBlockedReason` is a
  // single shared predicate that evaluates review/catalog blockers against an
  // explicit saved BOQ and active-mutation count, so the same logic can serve a
  // render-safe gate (state) and a synchronous event revalidation (refs)
  // without reading refs during render. It deliberately ignores unsaved drafts.
  const computeApprovalBlockedReason = (
    savedBoq: Boq,
    activeMutationCount: number,
    refresh: { inFlight: boolean; required?: boolean },
  ): string | undefined => {
    if (savedBoq.status === "approved") return "This BOQ is approved and read only."
    if (approving) return "Approval is already in progress."
    if (saving) return "Save is in progress. Wait for it to finish before approving the saved version."
    if (addingItem) return "Adding a missing item is in progress."
    if (deletingBoq) return "A deletion is in progress."
    if (pendingDeletes.length > 0) return "Commit or undo the pending item deletion before approving."
    if (includingItemKeys.size > 0) return "Including an optional item is in progress."
    if (catalogModalBusy) return "Catalog matching is in progress."
    if (excludeBusy) return "Excluding an item is in progress."
    if (activeMutationCount > 0) return "Another change is still syncing. Wait for it to settle before approving the saved version."
    if (refresh.inFlight) return "The latest BOQ is still refreshing. Wait for it to finish, then retry approval."
    if (refresh.required) return "The latest BOQ needs to refresh before approval. Retry in a moment."
    // Saved-version blockers are verified against the canonical boq so drafts
    // can neither fix nor introduce them.
    const savedVerification = buildReviewVerification(savedBoq, {
      vendor: savedBoq.vendor,
      project: savedBoq.project,
      workType: savedBoq.workType,
      date: savedBoq.date,
      items: savedBoq.sections.flatMap((section) => section.items),
    })
    if (savedVerification.hasBlockingIssues) return "Resolve the review blockers before approving."
    if (requireCatalogReadiness) {
      const savedCatalogReadiness = getBoqCatalogReadiness(savedBoq)
      if (savedCatalogReadiness.blocking > 0) return "Resolve catalog matching before approving."
    }
    return undefined
  }

  // Render-safe gate: derived from canonical boq state + the state-tracked
  // active mutation count + the in-flight refresh state mirror. Never reads a
  // ref, so it is safe to call in render. It blocks on an in-flight refresh but
  // intentionally not on `required`, so an approval attempt can still schedule a
  // needed refresh and ask the user to retry (no permanent no-retry dead end).
  const approvalDisabledReason = computeApprovalBlockedReason(
    boq,
    activeCanonicalMutations,
    { inFlight: canonicalRefreshInFlight },
  )

  // Event-only revalidation: re-checks blockers synchronously against the refs
  // so the click path stays accurate even mid render-batch, including the
  // in-flight and required canonical-refresh refs.
  const approvalBlockedReason = (): string | undefined =>
    computeApprovalBlockedReason(
      boqRef.current,
      activeCanonicalMutationsRef.current,
      { inFlight: canonicalRefreshRef.current !== null, required: canonicalRefreshNeededRef.current },
    )

  const approveSavedVersion = async () => {
    // Re-check blockers at execute time: the warning may have been open for a
    // while and the canonical state could have shifted underneath us.
    const blockedReason = approvalBlockedReason()
    if (blockedReason) {
      // If approval is only blocked by a required-but-not-in-flight canonical
      // refresh, kick it off so retrying isn't a permanent no-retry dead end.
      if (canonicalRefreshNeededRef.current && !canonicalRefreshRef.current) {
        void refreshCanonicalAfterIdle()
        toast.error("Refreshing the latest BOQ. Please retry approval in a moment.")
        return
      }
      toast.error(blockedReason)
      return
    }
    setApproveWarningOpen(false)
    // Raise the synchronous barrier before publishing the approving state so no
    // draft/canonical handler can race the approval PUT during the render gap.
    approvalBarrierRef.current = true
    setApproving(true)
    try {
      await runCanonicalMutation(async () => {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "approved" }),
        })
        if (!response.ok) throw new Error(await readError(response, "Failed to approve BOQ"))
        applyMutationBoq(await response.json() as Boq, { force: true })
        // Only after the protected saved version has been force-applied do we
        // discard the local drafts (item edits, metadata edits, invalid
        // component drafts). A failure above throws before reaching here, so
        // every draft survives verbatim for a retry.
        replaceEdits({})
        replaceMetadataEdits({})
        invalidDraftRef.current = new Set()
        setInvalidDraftKeys(new Set())
        toast.success("BOQ approved and linked to the Standard Catalog")
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to approve BOQ")
    } finally {
      approvalBarrierRef.current = false
      setApproving(false)
    }
  }

  const requestApproval = () => {
    const blockedReason = approvalBlockedReason()
    if (blockedReason) {
      // If approval is only blocked by a required-but-not-in-flight canonical
      // refresh, kick it off so retrying isn't a permanent no-retry dead end.
      if (canonicalRefreshNeededRef.current && !canonicalRefreshRef.current) {
        void refreshCanonicalAfterIdle()
        toast.error("Refreshing the latest BOQ. Please retry approval in a moment.")
        return
      }
      toast.error(blockedReason)
      return
    }
    // Drafts exist: confirm before approving the saved version and discarding
    // them. With no drafts, approve the saved version directly.
    if (pendingChanges > 0) {
      setApproveWarningOpen(true)
      return
    }
    void approveSavedVersion()
  }

  const reloadAfterManualMatch = async (_standardId: string, standardDescription: string) => {
    if (approving || approvalBarrierRef.current) return
    setCatalogModalBusy(true)
    try {
      await runCanonicalMutation(async () => {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}`)
        if (!response.ok) throw new Error(await readError(response, "The updated BOQ could not be loaded"))
        applyMutationBoq(await response.json() as Boq)
        setCatalogMatchTarget(null)
        toast.success(`Matched to: “${standardDescription}”`)
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The catalog match could not be applied")
    } finally {
      setCatalogModalBusy(false)
    }
  }

  const handleExclude = async () => {
    if (!excludeTarget || isReadOnly || approving || approvalBarrierRef.current) return
    setExcludeBusy(true)
    try {
      await runCanonicalMutation(async () => {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}/items`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            updates: [{
              sectionIndex: excludeTarget.sectionIndex,
              items: [{
                ...getBoqItemRequestIdentity(excludeTarget.item),
                stdStatus: "excluded",
                ...(excludeReason.trim() ? { stdExclusionReason: excludeReason.trim() } : {}),
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
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The item could not be excluded")
    } finally {
      setExcludeBusy(false)
    }
  }

  const handleAddWorkspaceUnit = useCallback(
    async (raw: string): Promise<string> => {
      const result = await addWorkspaceUnit(raw)
      setCustomUnits(result.customUnits)
      setWorkspaceUnitsError(null)
      toast.success(`“${result.unit}” added to workspace units`)
      return result.unit
    },
    [],
  )

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
    if (deletingBoq || approving || approvalBarrierRef.current) return
    const confirmed = window.confirm(
      `Delete the entire BOQ “${boq.project}” and its source PDF? This cannot be undone.`,
    )
    if (!confirmed) return
    setDeletingBoq(true)
    try {
      await runCanonicalMutation(async () => {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boqRef.current.id)}`, { method: "DELETE" })
        if (!response.ok) throw new Error(await readError(response, "The BOQ could not be deleted"))
        window.location.assign("/boqs")
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The BOQ could not be deleted")
    } finally {
      setDeletingBoq(false)
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
              <Button type="button" variant="outline" size="sm" onClick={() => setRightPaneMode(rightPaneMode === "items" ? "extraction" : "items")} aria-controls={rightPaneMode === "items" ? "boq-extraction-panel" : "boq-items-panel"}>
                {rightPaneMode === "items" ? <><Sparkles aria-hidden="true" />Extraction review</> : <><FileSearch aria-hidden="true" />BOQ items</>}
              </Button>
            ) : null}
            {!isReadOnly ? (
              <>
                {pendingChanges > 0 ? <span className="boq-unsaved-status" role="status">Unsaved changes</span> : null}
                <Button type="button" variant="outline" size="sm" onClick={() => void handleSaveAll()} disabled={saving || approving || invalidDraftKeys.size > 0}>
                  {saving ? <Loader2 className="animate-spin" /> : <Save aria-hidden="true" />}Save draft
                </Button>
                <Button type="button" size="sm" onClick={requestApproval} disabled={Boolean(approvalDisabledReason)}>
                  {approving ? <Loader2 className="animate-spin" /> : <Check aria-hidden="true" />}Approve BOQ
                </Button>
              </>
            ) : null}
            <details className="boq-overflow-menu">
              <summary className="btn btn-ghost btn-sm" aria-label="More BOQ actions"><MoreHorizontal aria-hidden="true" /><span className="sr-only">More BOQ actions</span></summary>
              <div className="boq-overflow-menu-content" role="menu">
                <button type="button" role="menuitem" onClick={handleExportCsv}><FileDown aria-hidden="true" />Export CSV</button>
                <button type="button" role="menuitem" onClick={() => window.print()}><Printer aria-hidden="true" />Print / download</button>
                <button type="button" role="menuitem" className="text-destructive" disabled={deletingBoq || approving} onClick={() => void handleDeleteBoq()}><Trash2 aria-hidden="true" />Delete BOQ</button>
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
              requestedPage={pdfEvidenceFocus.page}
              requestedPageKey={pdfEvidenceFocus.key}
            />
          ) : null}
        >
          <div className="boq-items-mode" id="boq-items-panel" hidden={rightPaneMode !== "items"}>
          <div className="review-metadata">
            <h2 className="text-sm font-medium mb-3">BOQ Details</h2>
            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Vendor" value={displayBoq.vendor} field="vendor" disabled={isReadOnly || saving || approving} confidence={confidenceLabel(boq.metadataConfidence?.vendor)} onChange={handleMetadataChange} />
              <MetaField label="Project" value={displayBoq.project} field="project" disabled={isReadOnly || saving || approving} confidence={confidenceLabel(boq.metadataConfidence?.project)} onChange={handleMetadataChange} />
              <MetaField label="Work Type" value={displayBoq.workType} field="workType" type="select" options={["Unclassified", "Structural", "MEP", "Finishing"]} disabled={isReadOnly || saving || approving} confidence={confidenceLabel(boq.metadataConfidence?.workType)} onChange={handleMetadataChange} />
              <MetaField label="Document Date" value={displayBoq.date} field="date" type="date" disabled={isReadOnly || saving || approving} confidence={confidenceLabel(boq.metadataConfidence?.date)} onChange={handleMetadataChange} />
            </div>
          </div>

          {boq.extractionWarnings?.length ? (
            <ExtractionWarnings warnings={boq.extractionWarnings} title="Extraction notes" />
          ) : null}

          <div className="boq-detail-toolbar" data-od-id="toolbar">
            <div className="search-wrap">
              <Search aria-hidden="true" />
              <Input placeholder="Search items…" value={search} onChange={(event) => setSearch(event.target.value)} className="proto-input" />
            </div>
          </div>

          <div className="review-items-heading">
            <span className="text-sm font-medium">Parsed Items · {items.length} line items</span>
            <div className="review-items-heading-actions">
              <span className="font-mono text-sm">Grand Total: ฿{grandTotal.toLocaleString()}</span>
              {!isReadOnly ? <Button type="button" variant="outline" size="sm" onClick={() => void handleAddMissingItem()} disabled={addingItem || approving || boq.sections.length === 0} data-od-id="add-missing-item">{addingItem ? <Loader2 className="animate-spin" /> : <Plus aria-hidden="true" />}Add missing item</Button> : null}
            </div>
          </div>
          {unifiedSections.length > 0 ? (
            <UnifiedBoqItemsTable
              sections={unifiedSections}
              readOnly={isReadOnly}
              editingDisabled={saving || approving}
              catalogDisabled={approving}
              catalogState={catalogMatching.rowState}
              onFieldChange={handleFieldChange}
              onAcceptSuggestion={(row) => { void handleAcceptCatalogSuggestion(row) }}
              onAiSuggest={(row) => { void handleAiSuggest(row) }}
              onDismissSuggestion={catalogMatching.dismissSuggestion}
              onFindMatch={setCatalogMatchTarget}
              onExclude={(row) => { setExcludeTarget(row); setExcludeReason("") }}
              onIncludeOptional={(row) => { void handleIncludeOptional(row) }}
              onClearCatalogError={catalogMatching.clearRowError}
              onComponentDraftValidityChange={handleComponentDraftValidityChange}
              onDelete={handleDelete}
              isIncludeBusy={(row) => Boolean(row.identityKey && includingItemKeys.has(row.identityKey))}
              units={units}
              workspaceUnitsError={workspaceUnitsError}
              onAddUnit={handleAddWorkspaceUnit}
            />
          ) : (
            <div className="proto-empty-state boq-filter-empty"><p>No items match your search</p></div>
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
              onNavigateToEvidence={(focus) => setPdfEvidenceFocus((current) => ({ page: focus.page, key: current.key + 1 }))}
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

      <Dialog open={Boolean(excludeTarget)} onOpenChange={(open) => { if (!open && !excludeBusy) { setExcludeTarget(null); setExcludeReason("") } }}>
        <DialogContent showCloseButton={!excludeBusy}>
          <DialogHeader>
            <DialogTitle>Exclude from catalog matching</DialogTitle>
            <DialogDescription>Add a reason so reviewers understand why {excludeTarget?.item.desc ?? "this item"} should not use catalog pricing. (optional)</DialogDescription>
          </DialogHeader>
          <Input value={excludeReason} onChange={(event) => setExcludeReason(event.target.value)} placeholder="Optional — reason this line should not use catalog pricing" aria-label={`Exclusion reason for ${excludeTarget?.item.desc ?? "item"}`} disabled={excludeBusy} autoFocus />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={excludeBusy} onClick={() => { setExcludeTarget(null); setExcludeReason("") }}>Cancel</Button>
            <Button type="button" disabled={excludeBusy} onClick={() => void handleExclude()}>{excludeBusy ? <Loader2 className="animate-spin" /> : null}Exclude item</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={approveWarningOpen} onOpenChange={(open) => { if (!open) setApproveWarningOpen(false) }}>
        <AlertDialogContent initialFocus={approveCancelRef} showCloseButton={false}>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve saved version?</AlertDialogTitle>
            <AlertDialogDescription>{pendingChanges} unsaved change(s) will not be included and will be discarded.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose ref={approveCancelRef} render={<Button type="button" variant="outline" />}>Cancel</AlertDialogClose>
            <Button type="button" onClick={() => void approveSavedVersion()} disabled={approving}>{approving ? <Loader2 className="animate-spin" /> : null}Approve saved version</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
