"use client"

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import {
  Check,
  FileSearch,
  Loader2,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { usePathname } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SourceBackedItemEditor, type SourceBackedItemPayload } from "@/components/source-backed-item-editor"
import { EvidenceOnlyBatchItemEditor } from "@/components/evidence-only-batch-item-editor"
import type { EvidenceOnlyDecisionBatchPayload } from "@/components/evidence-only-batch-item-editor-state"
import type { ExtractionReviewSourceRow } from "@/lib/boq-extraction-ai-review"
import {
  acceptAllValidatedProposalIds,
  beginReviewSnapshotRequest,
  extractionReviewRefreshAction,
  extractionReviewReducer,
  initialExtractionReviewState,
  invalidateReviewSnapshotRequests,
  isLatestReviewSnapshotRequest,
  normalizeExtractionReviewResponse,
  selectEffectiveFilter,
  selectReviewVisibility,
  selectReviewTab,
  type ExtractionProposalAction,
  type ExtractionReviewFilter,
} from "@/lib/boq-extraction-review-state"
import { extractionReviewOutcomeMessage, extractionReviewOutcomeTitle, firstInboxSentence, INBOX_CHIP_LABEL, inboxChipForProposal, inboxPendingCount, inboxRowTitle, proposalCanBeAccepted, proposalCanBeReviewedAndAdded, proposalManualAddMode, rejectionLabelGroups, selectExtractionReviewOutcome, sourceReferenceLabel, unpricedInboxGroupIds } from "@/lib/boq-extraction-review-ui"
import { isReviewActionableOperation, type ValidatedProposal } from "@/lib/boq-extraction-proposals"
import type { Boq } from "@/lib/boq-schema"
import { safeReviewReturnPath } from "@/lib/auth-return-url"

/** Client guard so a hung review POST can never strand the loading spinner.
 *  Sits above the 20s server provider timeout, so the server responds first in normal cases. */
const REVIEW_FETCH_TIMEOUT_MS = 30_000

interface EvidenceFocus {
  page: number
  table: number
  row: number
  cells: Array<{ column: number; line: string | undefined }>
}

interface ExtractionReviewProps {
  boq: Boq
  canonicalRevisionKey: string
  onBoqChange: (boq: Boq) => void
  onNavigateToEvidence: (focus: EvidenceFocus) => void
  sourceAvailable: boolean
  readOnly?: boolean
  mutationBlockedReason?: string
  onInboxCountChange?: (count: number) => void
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    return typeof body.error === "string" ? body.error : fallback
  } catch {
    return fallback
  }
}

function SourceEvidence({ source, onNavigateToEvidence, onRecheck, disabled, checking }: {
  source: ExtractionReviewSourceRow
  onNavigateToEvidence: (focus: EvidenceFocus) => void
  onRecheck: (sourceRowId: string) => void
  disabled: boolean
  checking: boolean
}) {
  const evidenceFocus = useMemo(() => ({
    page: source.page,
    table: source.table,
    row: source.row,
    cells: source.rawCells.map(cell => ({ column: cell.column, line: cell.lines?.[0] })),
  }), [source.page, source.table, source.row, source.rawCells])

  return (
    <section className="extraction-structure extraction-original" aria-label={`Original source row ${source.sourceRowId}`}>
      <div className="extraction-structure-heading">
        <span>Original source</span>
        <span>{Math.round(source.confidence * 100)}% extraction</span>
      </div>
      <p className="extraction-source-raw">{source.rawText || "No raw text retained"}</p>
      {source.rawCells.length > 0 ? (
        <dl className="extraction-cell-evidence">
          {source.rawCells.map((cell, index) => (
            <div key={`${source.sourceRowId}-cell-${cell.column}-${index}`}>
              <dt>{source.headers[cell.column] || `Column ${cell.column + 1}`}</dt>
              <dd>{cell.rawText || "—"}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {source.warnings.length > 0 ? <ul className="extraction-source-warnings">{source.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul> : null}
      <div className="extraction-source-actions">
        <button type="button" onClick={() => onNavigateToEvidence(evidenceFocus)} aria-label={`Show source row on PDF page ${source.page}`}>
          <FileSearch aria-hidden="true" />Review source
        </button>
        <button type="button" onClick={() => onRecheck(source.sourceRowId)} disabled={disabled}>{checking ? "Checking…" : "Review this row with AI"}</button>
      </div>
    </section>
  )
}

function ProposedStructure({ proposal }: { proposal: ValidatedProposal }) {
  const emptyMessage = proposal.operation === "remove_spurious_item"
    ? "Remove the current non-item row without adding a replacement."
    : proposal.operation === "needs_human_review"
      ? "No safe automatic correction is available."
      : "No BOQ change is proposed."
  return (
    <section className="extraction-structure extraction-proposed" aria-label="Proposed structure">
      <div className="extraction-structure-heading"><span>Proposed structure</span><span>{proposal.proposedItems.length} item{proposal.proposedItems.length === 1 ? "" : "s"}</span></div>
      {proposal.proposedItems.length > 0 ? (
        <ul>
          {proposal.proposedItems.map((item) => (
            <li key={item.id} className={item.pricingRole === "bundle_child" ? "bundle-child" : undefined}>
              <strong>{item.desc}</strong>
              {item.pricingRole === "bundle_child" ? <small>Informational child · no second total</small> : (
                <>
                  <small>{item.qty} {item.unit} × ฿{item.rate.toLocaleString()} = ฿{item.total.toLocaleString()}</small>
                  {item.sourceCosts ? <small>Material ฿{item.sourceCosts.material.total.toLocaleString()} + Labour ฿{item.sourceCosts.labour.total.toLocaleString()} · one combined BOQ row</small> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : <p>{emptyMessage}</p>}
    </section>
  )
}

function CurrentStructure({ boq, proposal }: { boq: Boq; proposal: ValidatedProposal }) {
  const items = boq.sections.flatMap((section) => section.items).filter((item) => typeof item.id === "string" && proposal.targetItemIds.includes(item.id))
  return (
    <section className="extraction-current-structure" aria-label="Current BOQ structure">
      <div className="extraction-structure-heading"><span>Current BOQ structure</span><span>{items.length} target{items.length === 1 ? "" : "s"}</span></div>
      {items.length ? <ul>{items.map((item) => <li key={item.id}><strong>{item.desc}</strong>{"qty" in item ? <small>{item.qty} {item.unit} × ฿{item.rate.toLocaleString()} = ฿{item.total.toLocaleString()}</small> : <small>Informational bundle child</small>}</li>)}</ul> : <p>No current target item. The proposal refers only to retained source evidence.</p>}
    </section>
  )
}

const OPERATION_LABELS: Record<string, string> = {
  insert_missing_item: "Add missing item",
  replace_item: "Replace item",
  remove_spurious_item: "Remove non-item row",
  needs_human_review: "Needs human review",
  keep: "Keep",
  split: "Split",
  merge: "Merge",
  separate_components: "Separate components",
  create_bundle: "Create bundle",
}

const REVIEW_FILTERS: Array<{ value: ExtractionReviewFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "needs-attention", label: "Needs attention" },
  { value: "ambiguous", label: "Ambiguous rows" },
  { value: "unreconciled", label: "Unreconciled rows" },
  { value: "ai-pending", label: "AI pending" },
]

export function ExtractionReview({ boq, canonicalRevisionKey, onBoqChange, onInboxCountChange, onNavigateToEvidence, sourceAvailable, readOnly = false, mutationBlockedReason }: ExtractionReviewProps) {
  const pathname = usePathname()
  const [extractionRunId, setExtractionRunId] = useState(boq.activeExtractionRunId)
  const [state, dispatch] = useReducer(extractionReviewReducer, undefined, initialExtractionReviewState)
  const [reextracting, setReextracting] = useState(false)
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null)
  const [sourceBackedError, setSourceBackedError] = useState<string | null>(null)
  const [rejectConfirmProposalId, setRejectConfirmProposalId] = useState<string | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null)
  const autoReviewedRunRef = useRef<string | null>(null)
  const recoveryAttemptRef = useRef<string | null>(null)
  const canonicalRevisionRef = useRef(canonicalRevisionKey)
  const reviewSnapshotGenerationRef = useRef(0)
  const { review, loading, requestedSourceRowId, error, proposalActions: actions, proposalStatuses: statuses } = state

  const inboxPending = useMemo(() => review ? inboxPendingCount(review.proposals, statuses) : 0, [review, statuses])
  useEffect(() => {
    onInboxCountChange?.(inboxPending)
  }, [onInboxCountChange, inboxPending])

  const runReview = useCallback(async ({ sourceRowId, force = false, notify = false }: { sourceRowId?: string; force?: boolean; notify?: boolean } = {}) => {
    if (!extractionRunId) {
      dispatch({ type: "review_failed", error: "This BOQ has no immutable extraction evidence. Re-extract the source to create review proposals without overwriting saved edits." })
      return
    }
    invalidateReviewSnapshotRequests(reviewSnapshotGenerationRef)
    dispatch({ type: "review_started", sourceRowId })
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => timeoutController.abort(), REVIEW_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourceRowId ? { manual: true, force, sourceRowIds: [sourceRowId] } : { manual: false, force }),
        signal: timeoutController.signal,
      })
      if (response.status === 401) {
        setSessionExpired(true)
        dispatch({ type: "review_failed", error: "Session expired. Please sign in again." })
        return null
      }
      if (!response.ok) throw new Error(await readError(response, "AI extraction review could not be completed."))
      const normalized = normalizeExtractionReviewResponse(await response.json())
      if (!normalized) throw new Error("AI review returned an unsupported response. The imported BOQ remains unchanged.")
      dispatch({ type: "review_succeeded", response: normalized, sourceRowId })
      if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
      if (normalized.mode === "fallback") toast.warning(normalized.message)
      else if (notify) toast.success(sourceRowId ? "Source row reviewed" : "AI review refreshed")
      return normalized
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === "AbortError"
      dispatch({ type: "review_failed", error: aborted ? "AI extraction review timed out. Try rechecking with AI again." : cause instanceof Error ? cause.message : "AI extraction review could not be completed. The imported BOQ remains unchanged." })
      return null
    } finally {
      clearTimeout(timeout)
    }
  }, [boq.id, extractionRunId])

  useEffect(() => {
    if (!extractionRunId) return
    let active = true
    const requestGeneration = beginReviewSnapshotRequest(reviewSnapshotGenerationRef)
    void (async () => {
      dispatch({ type: "review_started" })
      try {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`)
        if (!active || !isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) return
        if (response.status === 401) {
          if (active && isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) {
            setSessionExpired(true)
            dispatch({ type: "review_failed", error: "Session expired. Please sign in again." })
          }
          return
        }
        if (!response.ok) {
          if (readOnly) throw new Error(await readError(response, "Saved extraction review could not be loaded."))
          // Only the auto-trigger POST needs to run once per run; the GET above is idempotent
          // and must be allowed to re-run on StrictMode remount so loading always resolves.
          if (autoReviewedRunRef.current !== extractionRunId) {
            autoReviewedRunRef.current = extractionRunId
            void runReview()
          }
          return
        }
        const normalized = normalizeExtractionReviewResponse(await response.json())
        if (!normalized) throw new Error("Saved extraction review returned an unsupported response.")
        if (!active || !isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) return
        const refreshAction = extractionReviewRefreshAction(normalized, readOnly)
        const recoveryKey = `${extractionRunId}:${normalized.reviewRun?.status ?? "legacy"}:${normalized.reviewRun?.requestKey ?? ""}:${normalized.reviewRun?.leaseExpiresAt ?? "missing"}`
        if (refreshAction === "dispatch") recoveryAttemptRef.current = recoveryKey
        dispatch({ type: "review_succeeded", response: normalized })
        if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
        if (refreshAction === "dispatch") void runReview()
      } catch (cause) {
        if (active && isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "Saved extraction review could not be loaded." })
      }
    })()
    return () => { active = false }
  }, [boq.id, extractionRunId, readOnly, runReview])

  useEffect(() => () => {
    invalidateReviewSnapshotRequests(reviewSnapshotGenerationRef)
  }, [boq.id, extractionRunId])

  useEffect(() => {
    if (!extractionRunId || !review) return
    const refreshAction = extractionReviewRefreshAction(review, readOnly)
    const recoveryKey = `${extractionRunId}:${review.reviewRun?.status ?? "legacy"}:${review.reviewRun?.requestKey ?? ""}:${review.reviewRun?.leaseExpiresAt ?? "missing"}`
    if (refreshAction === "dispatch") {
      if (recoveryAttemptRef.current === recoveryKey) return
      recoveryAttemptRef.current = recoveryKey
      void runReview()
      return
    }
    if (refreshAction !== "poll") return
    recoveryAttemptRef.current = null
    let active = true
    const timer = window.setTimeout(() => {
      const requestGeneration = beginReviewSnapshotRequest(reviewSnapshotGenerationRef)
      void fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`)
        .then(async (response) => {
          if (response.status === 401) {
            if (active && isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) {
              setSessionExpired(true)
              dispatch({ type: "review_failed", error: "Session expired. Please sign in again." })
            }
            return
          }
          if (!response.ok) throw new Error(await readError(response, "Running extraction review could not be refreshed."))
          return normalizeExtractionReviewResponse(await response.json())
        })
        .then((normalized) => {
          if (!active || !normalized || !isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) return
          dispatch({ type: "review_succeeded", response: normalized })
          if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
        })
        .catch((cause) => {
          if (active && isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "Running extraction review could not be refreshed." })
        })
    }, 1_000)
    return () => { active = false; window.clearTimeout(timer) }
  }, [boq.id, extractionRunId, readOnly, review, runReview])

  const refreshStoredReview = useCallback(async () => {
    if (!extractionRunId) return false
    const requestGeneration = beginReviewSnapshotRequest(reviewSnapshotGenerationRef)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`)
      if (response.status === 401) {
        setSessionExpired(true)
        dispatch({ type: "review_failed", error: "Session expired. Please sign in again." })
        return false
      }
      if (!response.ok) throw new Error(await readError(response, "Extraction review state could not be refreshed."))
      const normalized = normalizeExtractionReviewResponse(await response.json())
      if (!normalized) throw new Error("Saved extraction review returned an unsupported response.")
      if (!isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) return false
      dispatch({ type: "review_succeeded", response: normalized })
      if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
      return true
    } catch (cause) {
      if (!isLatestReviewSnapshotRequest(reviewSnapshotGenerationRef, requestGeneration)) return false
      dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "Extraction review state could not be refreshed." })
      return false
    }
  }, [boq.id, extractionRunId])

  useEffect(() => {
    if (canonicalRevisionRef.current !== canonicalRevisionKey) {
      canonicalRevisionRef.current = canonicalRevisionKey
      void refreshStoredReview()
    }
  }, [canonicalRevisionKey, refreshStoredReview])

  const executeAction = useCallback(async (proposal: ValidatedProposal, action: "accept" | "reject" | "undo" | "skip") => {
    if (!extractionRunId) return false
    const actionState: ExtractionProposalAction = action === "accept" ? "accepting" : action === "reject" ? "rejecting" : action === "undo" ? "undoing" : "skipping"
    if (readOnly) return false
    if (mutationBlockedReason && (action === "accept" || action === "undo")) {
      toast.warning(mutationBlockedReason)
      return false
    }
    dispatch({ type: "proposal_action_started", proposalId: proposal.id, action: actionState })
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/proposals/${encodeURIComponent(proposal.id)}/${action}`, {
        method: "POST",
      })
      if (response.status === 401) {
        setSessionExpired(true)
        dispatch({ type: "proposal_action_failed", proposalId: proposal.id, error: "Session expired. Please sign in again." })
        return false
      }
      if (!response.ok) throw new Error(await readError(response, `Suggestion could not be ${action}ed.`))
      const result = await response.json() as { boq?: Boq }
      if (result.boq) onBoqChange(result.boq)
      dispatch({ type: "proposal_status", proposalId: proposal.id, status: action === "accept" ? "accepted" : action === "reject" ? "rejected" : action === "skip" ? "skipped" : "undone", canUndo: false })
      if (action === "accept" || action === "undo" || action === "skip") await refreshStoredReview()
      toast.success(action === "accept" ? "Suggestion accepted" : action === "reject" ? "Suggestion rejected" : action === "skip" ? "Suggestion skipped" : "Suggestion undone")
      return true
    } catch (cause) {
      dispatch({ type: "proposal_action_failed", proposalId: proposal.id, error: cause instanceof Error ? cause.message : `Suggestion could not be ${action}ed.` })
      return false
    }
  }, [boq.id, extractionRunId, mutationBlockedReason, onBoqChange, readOnly, refreshStoredReview])

  const handleReject = useCallback((proposal: ValidatedProposal) => {
    setRejectConfirmProposalId(proposal.id)
  }, [])

  const handleConfirmedReject = useCallback(async (proposal: ValidatedProposal) => {
    setRejectConfirmProposalId(null)
    await executeAction(proposal, "reject")
  }, [executeAction])

  const submitSourceBackedItem = useCallback(async (proposal: ValidatedProposal, payload: SourceBackedItemPayload | EvidenceOnlyDecisionBatchPayload) => {
    if (!extractionRunId || readOnly) return { ok: false as const, error: "This BOQ is read-only." }
    if (mutationBlockedReason) {
      setSourceBackedError(mutationBlockedReason)
      return { ok: false as const, error: mutationBlockedReason }
    }
    dispatch({ type: "proposal_action_started", proposalId: proposal.id, action: "adding" })
    setSourceBackedError(null)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/proposals/${encodeURIComponent(proposal.id)}/add-source-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (response.status === 401) {
        const message = "Session expired. Please sign in again."
        dispatch({ type: "proposal_action_failed", proposalId: proposal.id, error: message })
        setSourceBackedError(message)
        setSessionExpired(true)
        return { ok: false as const, error: message }
      }
      if (!response.ok) {
        const message = await readError(response, "BOQ item could not be added from the reviewed source.")
        dispatch({ type: "proposal_action_failed", proposalId: proposal.id, error: message })
        setSourceBackedError(message)
        return { ok: false as const, error: message }
      }
      const result = await response.json() as { boq?: Boq }
      if (result.boq) onBoqChange(result.boq)
      dispatch({ type: "proposal_status", proposalId: proposal.id, status: "accepted", canUndo: false })
      await refreshStoredReview()
      setEditingProposalId(null)
      setSourceBackedError(null)
      toast.success("BOQ item added from reviewed source.")
      return { ok: true as const }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "BOQ item could not be added from the reviewed source."
      dispatch({ type: "proposal_action_failed", proposalId: proposal.id, error: message })
      setSourceBackedError(message)
      return { ok: false as const, error: message }
    }
  }, [boq.id, extractionRunId, mutationBlockedReason, onBoqChange, readOnly, refreshStoredReview])

  const bulkProposalIds = useMemo(() => acceptAllValidatedProposalIds(review?.proposals ?? [], statuses), [review, statuses])
  const hasStaleProposals = review?.proposals.some((proposal) => proposal.stale) === true
  const acceptAll = async () => {
    if (!extractionRunId || readOnly || mutationBlockedReason || bulkProposalIds.length === 0) return
    bulkProposalIds.forEach((proposalId) => dispatch({ type: "proposal_action_started", proposalId, action: "accepting" }))
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/proposals/accept-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalIds: bulkProposalIds }),
      })
      if (response.status === 401) {
        setSessionExpired(true)
        const message = "Session expired. Please sign in again."
        bulkProposalIds.forEach((proposalId) => dispatch({ type: "proposal_action_failed", proposalId, error: message }))
        return
      }
      if (!response.ok) throw new Error(await readError(response, "Validated suggestions could not be accepted atomically."))
      const result = await response.json() as { boq?: Boq }
      if (result.boq) onBoqChange(result.boq)
      bulkProposalIds.forEach((proposalId) => dispatch({ type: "proposal_status", proposalId, status: "accepted", canUndo: false }))
      await refreshStoredReview()
      toast.success(`${bulkProposalIds.length} validated suggestions accepted`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Validated suggestions could not be accepted atomically."
      bulkProposalIds.forEach((proposalId) => dispatch({ type: "proposal_action_failed", proposalId, error: message }))
    }
  }

  const reextract = async () => {
    setReextracting(true)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/re-extract`, { method: "POST" })
      if (!response.ok) throw new Error(await readError(response, "Source re-extraction could not be started."))
      const result = await response.json() as { extractionRun?: { id?: string } }
      if (!result.extractionRun?.id) throw new Error("Source re-extraction did not return immutable review evidence.")
      autoReviewedRunRef.current = null
      setExtractionRunId(result.extractionRun.id)
      toast.success("Source re-extracted. Saved BOQ edits were not overwritten.")
    } catch (cause) {
      dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "Source re-extraction could not be started." })
    } finally {
      setReextracting(false)
    }
  }

  const reviewRunStatus = review?.reviewRun?.status
  const busy = loading || reextracting || reviewRunStatus === "running" || Object.values(actions).some(Boolean)
  const effectiveFilter = useMemo(() => review ? selectEffectiveFilter(review, statuses, state.filter) : "all", [review, state.filter, statuses])
  const visibility = useMemo(() => review ? selectReviewVisibility(review, statuses, effectiveFilter) : { proposals: [], sourceRows: [] }, [review, effectiveFilter, statuses])
  const visibleProposals = visibility.proposals
  const visibleSourceRows = visibility.sourceRows
  const reviewOutcome = useMemo(() => review ? selectExtractionReviewOutcome(review) : null, [review])
  const blockedGroups = useMemo(() => review ? rejectionLabelGroups(review.reviewRun?.validationSummary ?? null) : [], [review])
  const filterCounts = useMemo(() => {
    const counts: Partial<Record<ExtractionReviewFilter, number>> = {}
    if (review) for (const filter of REVIEW_FILTERS) {
      const result = selectReviewVisibility(review, statuses, filter.value)
      counts[filter.value] = result.proposals.length + result.sourceRows.length
    }
    return counts
  }, [review, statuses])
  const sourceRowLabels = useMemo(() => {
    const labels = new Map<string, string>()
    if (review) {
      for (const reference of review.sourceRefs) labels.set(reference.sourceRowId, sourceReferenceLabel(reference))
      for (const sourceRow of review.sourceRows) if (!labels.has(sourceRow.sourceRowId)) labels.set(sourceRow.sourceRowId, sourceReferenceLabel(sourceRow))
    }
    return labels
  }, [review])
  useEffect(() => {
    if (!review || state.filter === "all") return
    if ((filterCounts[state.filter] ?? 0) === 0) dispatch({ type: "set_filter", filter: "all" })
  }, [review, state.filter, filterCounts])

  return (
    <section className="focused-extraction-review" data-od-id="focused-extraction-review" aria-labelledby="focused-extraction-title">
      <header className="focused-extraction-header">
        <div>
          <span className="review-eyebrow">Evidence review</span>
          <h2 id="focused-extraction-title">Missed rows</h2>
          <p>{inboxPending > 0 ? `${inboxPending} source lines are not in this BOQ yet.` : "No missed rows."}</p>
        </div>
        <div className="extraction-review-heading-actions">
          {bulkProposalIds.length > 0 && !readOnly ? <Button type="button" size="sm" onClick={() => void acceptAll()} disabled={busy || Boolean(mutationBlockedReason)}><Check aria-hidden="true" />Accept all validated high-confidence</Button> : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void runReview({ force: true, notify: true })} disabled={readOnly || !extractionRunId || busy}>{loading || reviewRunStatus === "running" ? <Loader2 className="animate-spin" /> : <Sparkles aria-hidden="true" />}{reviewRunStatus === "running" ? "AI review running" : "Review all flagged rows with AI"}</Button>
        </div>
      </header>

      {!extractionRunId ? (
        <div className="extraction-review-state" role="status">
          <TriangleAlert aria-hidden="true" />
          <div><strong>Immutable evidence is not available</strong><p>Re-extract source creates review proposals without overwriting saved BOQ edits.</p></div>
          {sourceAvailable && !readOnly ? <Button type="button" variant="outline" size="sm" onClick={() => void reextract()} disabled={reextracting}>{reextracting ? <Loader2 className="animate-spin" /> : <RotateCcw aria-hidden="true" />}Re-extract source</Button> : null}
        </div>
      ) : loading && !review ? (
        <div className="extraction-review-state" role="status"><Loader2 className="animate-spin" aria-hidden="true" />Checking only ambiguous, unreconciled, and compound rows…</div>
      ) : review ? (
        <div className={`extraction-review-result ${review.mode} ${reviewOutcome === "validation-blocked" || reviewOutcome === "proposals-partially-blocked" || reviewOutcome === "legacy-partial" ? "is-blocked" : ""}`} role="status">
          <div className="extraction-review-result-copy"><strong>{reviewOutcome ? extractionReviewOutcomeTitle(reviewOutcome) : ""}</strong><span>{reviewOutcome ? extractionReviewOutcomeMessage(review, reviewOutcome) : review.message}</span></div>
          <div className="extraction-review-result-counts">
            {review && review.proposals.length > 0 ? <small>{`${review.proposals.length - inboxPending} of ${review.proposals.length} leftovers cleared`}</small> : null}
          </div>
        </div>
      ) : null}

      {(() => {
        const rejectedCount = review?.reviewRun?.validationSummary?.rejectedProposalCount ?? 0
        if (rejectedCount === 0) return null
        return (
          <details className="extraction-review-technical-details">
            <summary>Technical details — {rejectedCount} response{rejectedCount === 1 ? "" : "s"} not applied</summary>
            {blockedGroups.length > 0 ? (
              <ul>
                {blockedGroups.map((group) => <li key={group.label}>{group.count} {group.label.toLowerCase()}{group.count === 1 ? "" : "s"}.</li>)}
              </ul>
            ) : (
              <p>{rejectedCount} response{rejectedCount === 1 ? "" : "s"} did not pass safety checks. A detailed breakdown was not retained.</p>
            )}
          </details>
        )
      })()}

      {review?.remainingCandidateRowIds.length ? <div className="extraction-remaining-rows" role="group" aria-label="Additional candidate source rows"><span>Rows needing review:</span>{review.remainingCandidateRowIds.map((sourceRowId, index) => { const label = sourceRowLabels.get(sourceRowId) ?? `Row ${index + 1}`; const checking = requestedSourceRowId === sourceRowId; return <button type="button" key={sourceRowId} onClick={() => void runReview({ sourceRowId, force: true, notify: true })} disabled={readOnly || busy} aria-label={checking ? `Checking ${label}` : `Review ${label} with AI`}>{checking ? "Checking…" : label}</button> })}</div> : null}

      {sessionExpired ? (
        <div className="review-save-error" role="alert">
          <strong>Your session has expired. Sign in again to continue reviewing this BOQ.</strong>
          <a href={`/?returnTo=${encodeURIComponent(safeReviewReturnPath(pathname))}`} className="btn btn-primary btn-sm">Sign in again</a>
        </div>
      ) : null}

      {error ? <div className="review-save-error" role="alert">{error}</div> : null}

      {mutationBlockedReason ? <div className="review-save-error" role="status"><strong>Save draft to continue</strong><span>{mutationBlockedReason}</span></div> : null}

      {hasStaleProposals ? <div className="review-save-error" role="status"><strong>Canonical BOQ changed. Recheck with AI</strong><span>Saved item or detail changes made these suggestions stale. Recheck before accepting them.</span></div> : null}

      {review?.mode === "ai" && review.proposals.length === 0 && (reviewOutcome === "no-correction" || reviewOutcome === "pending-follow-up") ? <div className="extraction-review-empty"><Check aria-hidden="true" /><strong>{reviewOutcome === "pending-follow-up" ? "No correction for reviewed rows" : "No correction proposals"}</strong><span>The deterministic BOQ remains unchanged. You can recheck an individual source row below.</span></div> : null}

      {review && (review.proposals.length > 0 || review.sourceRows.length > 0) ? (
        <div className="extraction-review-tabs" role="tablist" aria-label="Review proposals">
          <button type="button" className={state.tab === "needs-review" ? "tab active" : "tab"} role="tab" aria-selected={state.tab === "needs-review"} onClick={() => dispatch({ type: "set_tab", tab: "needs-review" })}>Inbox</button>
          <button type="button" className={state.tab === "history" ? "tab active" : "tab"} role="tab" aria-selected={state.tab === "history"} onClick={() => dispatch({ type: "set_tab", tab: "history" })}>Done</button>
        </div>
      ) : null}

      {review?.proposals.length ? (
        (() => {
          const tabState = selectReviewTab({ review, proposalStatuses: statuses }, state.tab)
          const tabProposals = tabState.proposals
          if (tabProposals.length === 0) return null
          const inboxRows = tabProposals.map((proposal) => {
            const sourceRef = review.sourceRefs.find((ref) => proposal.sourceRowIds.includes(ref.sourceRowId))
            return { id: proposal.id, proposal, chip: inboxChipForProposal(proposal, statuses[proposal.id], readOnly, review.sourceRows), sourceRef }
          })
          const unpricedGroupIds = unpricedInboxGroupIds(inboxRows)
          const openRow = inboxRows.find((row) => row.id === selectedInboxId) ?? inboxRows[0]
          const nextRows = inboxRows.filter((row) => row.id !== openRow.id)
          const renderInboxRow = (row: (typeof inboxRows)[number]) => (
            <button type="button" key={row.id} data-od-id="extraction-inbox-item" data-unpriced-group={unpricedGroupIds.includes(row.id) ? "true" : undefined} className={`extraction-inbox-item${row.id === openRow.id ? " is-now" : ""}`} onClick={() => { setSelectedInboxId(row.id); if (row.sourceRef) onNavigateToEvidence({ page: row.sourceRef.page, table: row.sourceRef.table, row: row.sourceRef.row, cells: [] }) }}>
              <strong>{inboxRowTitle(row.proposal, review.sourceRows)}</strong>
              <span className="extraction-inbox-meta">p.{row.sourceRef?.page} · {INBOX_CHIP_LABEL[row.chip]}</span>
            </button>
          )
          return (
            <div className="extraction-inbox" aria-label="Extraction review proposals">
              <span className="review-eyebrow">NOW</span>
              {renderInboxRow(openRow)}
              {(() => {
                const proposal = openRow.proposal
                const status = statuses[proposal.id]
                const action = actions[proposal.id]
                const sourceRows = review.sourceRows.filter((row) => proposal.sourceRowIds.includes(row.sourceRowId))
                const canAccept = proposalCanBeAccepted(proposal) && !status
                const canReviewAndAdd = proposalCanBeReviewedAndAdded(proposal, status, readOnly)
                const humanReview = proposal.operation === "needs_human_review"
                const manualAddMode = canReviewAndAdd ? proposalManualAddMode(proposal) : null
                const isIncomplete = humanReview && !canAccept
                const nonActionable = !isReviewActionableOperation(proposal.operation)
                const isComplete = canAccept || (!humanReview && !nonActionable && proposal.stale !== true)
                return (
                  <article className={`extraction-proposal focused ${status ? `is-${status}` : ""}`}>
                    <div className="extraction-proposal-labels">
                      <span className={`extraction-operation ${proposal.operation}`}>{OPERATION_LABELS[proposal.operation] ?? proposal.operation.replaceAll("_", " ")}</span>
                      <span className="extraction-validated">{isComplete ? "Validated suggestion — ready for your approval" : "More information needed"}</span>
                    </div>
                    <p>{firstInboxSentence(proposal.explanation)}</p>
                    <details className="extraction-inbox-details">
                      <summary>Details</summary>
                      <div className="extraction-structure-grid">
                        <div className="extraction-original-list">{sourceRows.map((source) => <SourceEvidence key={source.sourceRowId} source={source} onNavigateToEvidence={onNavigateToEvidence} onRecheck={(sourceRowId) => void runReview({ sourceRowId, force: true, notify: true })} disabled={readOnly || busy} checking={requestedSourceRowId === source.sourceRowId} />)}<CurrentStructure boq={boq} proposal={proposal} /></div>
                        <ProposedStructure proposal={proposal} />
                      </div>
                    </details>
                    <div className="extraction-validation-summary"><strong>Validation & reconciliation</strong>{humanReview ? <span><TriangleAlert aria-hidden="true" />No safe automatic correction; manual review required</span> : <><span><Check aria-hidden="true" />Source evidence valid</span><span><Check aria-hidden="true" />Arithmetic reconciled</span></>}{proposal.stale ? <span><X aria-hidden="true" />Proposal is stale</span> : null}</div>
                    <div className="extraction-proposal-footer">
                      {nonActionable ? <span className="extraction-human-review"><TriangleAlert aria-hidden="true" />{humanReview ? "Needs human review · acceptance disabled" : "Legacy suggestion · acceptance disabled"}</span> : <span />}
                      <div className="extraction-proposal-actions">
                        {status === "accepted" && state.proposalCanUndo[proposal.id] && !readOnly ? <Button type="button" variant="outline" size="sm" onClick={() => void executeAction(proposal, "undo")} disabled={Boolean(action) || Boolean(mutationBlockedReason)}>Undo{action === "undoing" ? <Loader2 className="animate-spin" /> : <Undo2 aria-hidden="true" />}</Button> : null}
                        {!status ? <>
                          {isComplete && canAccept ? <Button type="button" size="sm" onClick={() => void executeAction(proposal, "accept")} disabled={readOnly || Boolean(mutationBlockedReason) || Boolean(action)}>Accept{action === "accepting" ? <Loader2 className="animate-spin" /> : <Check aria-hidden="true" />}</Button> : null}
                          {isComplete ? <Button type="button" variant="ghost" size="sm" onClick={() => handleReject(proposal)} disabled={readOnly || Boolean(action)}>Reject{action === "rejecting" ? <Loader2 className="animate-spin" /> : <X aria-hidden="true" />}</Button> : null}
                          {isIncomplete && humanReview && canReviewAndAdd ? (
                            <Button type="button" variant="outline" size="sm" onClick={() => { setEditingProposalId(proposal.id); setSourceBackedError(null) }} disabled={Boolean(action)}>Review &amp; add</Button>
                          ) : null}
                          {isIncomplete ? <Button type="button" variant="ghost" size="sm" onClick={() => void executeAction(proposal, "skip")} disabled={readOnly || Boolean(action)}>Skip{action === "skipping" ? <Loader2 className="animate-spin" /> : null}</Button> : null}
                        </> : status !== "accepted" ? <span className="extraction-action-status">{status === "rejected" ? "Rejected" : status === "skipped" ? "Skipped" : "Undone"}</span> : null}
                      </div>
                    </div>
                    {editingProposalId === proposal.id && humanReview && canReviewAndAdd ? (
                      manualAddMode === "batch" ? (
                        <EvidenceOnlyBatchItemEditor
                          boq={boq}
                          proposal={proposal}
                          sourceRows={sourceRows}
                          busy={action === "adding"}
                          serverError={sourceBackedError}
                          onCancel={() => { setEditingProposalId(null); setSourceBackedError(null) }}
                          onSubmit={(payload) => submitSourceBackedItem(proposal, payload)}
                        />
                      ) : (
                        <SourceBackedItemEditor
                          boq={boq}
                          proposal={proposal}
                          sourceRows={sourceRows}
                          busy={action === "adding"}
                          serverError={sourceBackedError}
                          onCancel={() => { setEditingProposalId(null); setSourceBackedError(null) }}
                          onSubmit={(payload) => submitSourceBackedItem(proposal, payload)}
                        />
                      )
                    ) : null}
                  </article>
                )
              })()}
              {nextRows.length ? <>
                <span className="review-eyebrow">NEXT</span>
                {nextRows.map((row) => renderInboxRow(row))}
              </> : null}
            </div>
          )
        })()
      ) : null}

      {visibleSourceRows.length ? <div className="extraction-reviewed-source-list" aria-label="Visible source rows without proposals"><strong>{effectiveFilter === "all" ? "Candidate source rows without proposals" : "Source rows matching this filter"}</strong>{visibleSourceRows.map((source) => <SourceEvidence key={source.sourceRowId} source={source} onNavigateToEvidence={onNavigateToEvidence} onRecheck={(sourceRowId) => void runReview({ sourceRowId, force: true, notify: true })} disabled={readOnly || busy} checking={requestedSourceRowId === source.sourceRowId} />)}</div> : null}

      {review && effectiveFilter !== "all" && visibleProposals.length === 0 && visibleSourceRows.length === 0 ? <div className="extraction-review-empty"><FileSearch aria-hidden="true" /><strong>No matching review results</strong><span>Choose another filter to continue reviewing extraction evidence.</span></div> : null}

      {rejectConfirmProposalId ? (
        <Dialog open={Boolean(rejectConfirmProposalId)} onOpenChange={(open) => { if (!open) setRejectConfirmProposalId(null) }}>
          <DialogContent showCloseButton={!actions[rejectConfirmProposalId]}>
            <DialogHeader>
              <DialogTitle>Reject this suggestion?</DialogTitle>
              <DialogDescription>Reject this suggestion? It will not be added to the BOQ.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={Boolean(actions[rejectConfirmProposalId])} onClick={() => setRejectConfirmProposalId(null)}>Cancel</Button>
              <Button type="button" disabled={Boolean(actions[rejectConfirmProposalId])} onClick={() => { const proposal = review?.proposals.find(p => p.id === rejectConfirmProposalId); if (proposal) void handleConfirmedReject(proposal) }}>{actions[rejectConfirmProposalId] === "rejecting" ? <Loader2 className="animate-spin" /> : null}Confirm reject</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  )
}
