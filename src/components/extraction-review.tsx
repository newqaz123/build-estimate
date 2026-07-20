"use client"

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import {
  ArrowLeft,
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

import { Button } from "@/components/ui/button"
import type { ExtractionReviewResponse, ExtractionReviewSourceRow } from "@/lib/boq-extraction-ai-review"
import {
  acceptAllValidatedProposalIds,
  extractionReviewRefreshAction,
  extractionReviewReducer,
  filterReviewProposals,
  filterReviewSourceRows,
  initialExtractionReviewState,
  normalizeExtractionReviewResponse,
  type ExtractionProposalAction,
  type ExtractionReviewFilter,
} from "@/lib/boq-extraction-review-state"
import { proposalCanBeAccepted, proposalIsHighConfidence, sourceReferenceLabel } from "@/lib/boq-extraction-review-ui"
import type { ValidatedProposal } from "@/lib/boq-extraction-proposals"
import type { Boq } from "@/lib/boq-schema"

interface ExtractionReviewProps {
  boq: Boq
  onBack?: () => void
  onBoqChange: (boq: Boq) => void
  onNavigateToPage: (page: number) => void
  sourceAvailable: boolean
  readOnly?: boolean
  mutationBlockedReason?: string
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    return typeof body.error === "string" ? body.error : fallback
  } catch {
    return fallback
  }
}

function reviewTitle(review: ExtractionReviewResponse): string {
  if (review.mode === "fallback") return "AI review unavailable"
  if (review.mode === "not_required") return "No review needed"
  return review.proposals.length > 0 ? "AI suggestions ready" : "No proposals returned"
}

function SourceEvidence({ source, onNavigateToPage, onRecheck, disabled }: {
  source: ExtractionReviewSourceRow
  onNavigateToPage: (page: number) => void
  onRecheck: (sourceRowId: string) => void
  disabled: boolean
}) {
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
        <button type="button" onClick={() => onNavigateToPage(source.page)} aria-label={`Show source row on PDF page ${source.page}`}>
          <FileSearch aria-hidden="true" />{sourceReferenceLabel(source)}
        </button>
        <button type="button" onClick={() => onRecheck(source.sourceRowId)} disabled={disabled}>Recheck with AI</button>
      </div>
    </section>
  )
}

function ProposedStructure({ proposal }: { proposal: ValidatedProposal }) {
  return (
    <section className="extraction-structure extraction-proposed" aria-label="Proposed structure">
      <div className="extraction-structure-heading"><span>Proposed structure</span><span>{proposal.proposedItems.length} item{proposal.proposedItems.length === 1 ? "" : "s"}</span></div>
      {proposal.proposedItems.length > 0 ? (
        <ul>
          {proposal.proposedItems.map((item) => (
            <li key={item.id} className={item.pricingRole === "bundle_child" ? "bundle-child" : undefined}>
              <strong>{item.desc}</strong>
              {item.pricingRole === "bundle_child" ? <small>Informational child · no second total</small> : <small>{item.qty} {item.unit} × ฿{item.rate.toLocaleString()} = ฿{item.total.toLocaleString()}</small>}
            </li>
          ))}
        </ul>
      ) : <p>The reviewer recommends keeping the current BOQ structure.</p>}
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

export function ExtractionReview({ boq, onBack, onBoqChange, onNavigateToPage, sourceAvailable, readOnly = false, mutationBlockedReason }: ExtractionReviewProps) {
  const [extractionRunId, setExtractionRunId] = useState(boq.activeExtractionRunId)
  const [state, dispatch] = useReducer(extractionReviewReducer, undefined, initialExtractionReviewState)
  const [reextracting, setReextracting] = useState(false)
  const autoReviewedRunRef = useRef<string | null>(null)
  const recoveryAttemptRef = useRef<string | null>(null)
  const { review, loading, error, proposalActions: actions, proposalStatuses: statuses } = state

  const runReview = useCallback(async (sourceRowId?: string) => {
    if (!extractionRunId) {
      dispatch({ type: "review_failed", error: "This BOQ has no immutable extraction evidence. Re-extract the source to create review proposals without overwriting saved edits." })
      return
    }
    dispatch({ type: "review_started", sourceRowId })
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourceRowId ? { manual: true, sourceRowIds: [sourceRowId] } : { manual: false }),
      })
      if (!response.ok) throw new Error(await readError(response, "AI extraction review could not be completed."))
      const normalized = normalizeExtractionReviewResponse(await response.json())
      if (!normalized) throw new Error("AI review returned an unsupported response. The imported BOQ remains unchanged.")
      dispatch({ type: "review_succeeded", response: normalized, sourceRowId })
      if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
      if (normalized.mode === "fallback") toast.warning(normalized.message)
      return normalized
    } catch (cause) {
      dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "AI extraction review could not be completed. The imported BOQ remains unchanged." })
      return null
    }
  }, [boq.id, extractionRunId])

  useEffect(() => {
    if (!extractionRunId || autoReviewedRunRef.current === extractionRunId) return
    autoReviewedRunRef.current = extractionRunId
    let active = true
    void (async () => {
      dispatch({ type: "review_started" })
      try {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`)
        if (!active) return
        if (!response.ok) {
          if (!readOnly) return void runReview()
          throw new Error(await readError(response, "Saved extraction review could not be loaded."))
        }
        const normalized = normalizeExtractionReviewResponse(await response.json())
        if (!normalized) throw new Error("Saved extraction review returned an unsupported response.")
        const refreshAction = extractionReviewRefreshAction(normalized, readOnly)
        const recoveryKey = `${extractionRunId}:${normalized.reviewRun?.status ?? "legacy"}:${normalized.reviewRun?.requestKey ?? ""}:${normalized.reviewRun?.leaseExpiresAt ?? "missing"}`
        if (refreshAction === "dispatch") recoveryAttemptRef.current = recoveryKey
        dispatch({ type: "review_succeeded", response: normalized })
        if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
        if (refreshAction === "dispatch") void runReview()
      } catch (cause) {
        if (active) dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "Saved extraction review could not be loaded." })
      }
    })()
    return () => { active = false }
  }, [boq.id, extractionRunId, readOnly, runReview])

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
      void fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`)
        .then(async (response) => {
          if (!response.ok) throw new Error(await readError(response, "Running extraction review could not be refreshed."))
          return normalizeExtractionReviewResponse(await response.json())
        })
        .then((normalized) => {
          if (!active || !normalized) return
          dispatch({ type: "review_succeeded", response: normalized })
          if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
        })
        .catch((cause) => {
          if (active) dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "Running extraction review could not be refreshed." })
        })
    }, 1_000)
    return () => { active = false; window.clearTimeout(timer) }
  }, [boq.id, extractionRunId, readOnly, review, runReview])

  const refreshStoredReview = useCallback(async () => {
    if (!extractionRunId) return false
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/review`)
      if (!response.ok) throw new Error(await readError(response, "Extraction review state could not be refreshed."))
      const normalized = normalizeExtractionReviewResponse(await response.json())
      if (!normalized) throw new Error("Saved extraction review returned an unsupported response.")
      dispatch({ type: "review_succeeded", response: normalized })
      if (normalized.proposalStatuses) dispatch({ type: "proposal_statuses", statuses: normalized.proposalStatuses })
      return true
    } catch (cause) {
      dispatch({ type: "review_failed", error: cause instanceof Error ? cause.message : "Extraction review state could not be refreshed." })
      return false
    }
  }, [boq.id, extractionRunId])

  const executeAction = useCallback(async (proposal: ValidatedProposal, action: "accept" | "reject" | "undo") => {
    if (!extractionRunId) return false
    const actionState: ExtractionProposalAction = action === "accept" ? "accepting" : action === "reject" ? "rejecting" : "undoing"
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
      if (!response.ok) throw new Error(await readError(response, `Suggestion could not be ${action}ed.`))
      const result = await response.json() as { boq?: Boq }
      if (result.boq) onBoqChange(result.boq)
      dispatch({ type: "proposal_status", proposalId: proposal.id, status: action === "accept" ? "accepted" : action === "reject" ? "rejected" : "undone", canUndo: false })
      if (action === "accept" || action === "undo") await refreshStoredReview()
      toast.success(action === "accept" ? "Suggestion accepted" : action === "reject" ? "Suggestion rejected" : "Suggestion undone")
      return true
    } catch (cause) {
      dispatch({ type: "proposal_action_failed", proposalId: proposal.id, error: cause instanceof Error ? cause.message : `Suggestion could not be ${action}ed.` })
      return false
    }
  }, [boq.id, extractionRunId, mutationBlockedReason, onBoqChange, readOnly, refreshStoredReview])

  const bulkProposalIds = useMemo(() => acceptAllValidatedProposalIds(review?.proposals ?? [], statuses), [review, statuses])
  const acceptAll = async () => {
    if (!extractionRunId || readOnly || mutationBlockedReason || bulkProposalIds.length === 0) return
    bulkProposalIds.forEach((proposalId) => dispatch({ type: "proposal_action_started", proposalId, action: "accepting" }))
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/extraction-runs/${encodeURIComponent(extractionRunId)}/proposals/accept-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalIds: bulkProposalIds }),
      })
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
  const filteredSourceRows = useMemo(() => review && ["ambiguous", "unreconciled", "ai-pending"].includes(state.filter)
    ? filterReviewSourceRows(review, state.filter as "ambiguous" | "unreconciled" | "ai-pending") : [], [review, state.filter])
  const visibleProposals = useMemo(() => {
    const proposals = filterReviewProposals(review?.proposals ?? [], statuses, state.filter)
    if (!review || filteredSourceRows.length === 0 || !["ambiguous", "unreconciled", "ai-pending"].includes(state.filter)) return proposals
    const rowIds = new Set(filteredSourceRows.map((row) => row.sourceRowId))
    return proposals.filter((proposal) => proposal.sourceRowIds.some((rowId) => rowIds.has(rowId)))
  }, [filteredSourceRows, review, state.filter, statuses])
  const filteredRowsWithoutProposal = useMemo(() => {
    const proposedRowIds = new Set(visibleProposals.flatMap((proposal) => proposal.sourceRowIds))
    return filteredSourceRows.filter((row) => !proposedRowIds.has(row.sourceRowId))
  }, [filteredSourceRows, visibleProposals])

  return (
    <section className="focused-extraction-review" data-od-id="focused-extraction-review" aria-labelledby="focused-extraction-title">
      <header className="focused-extraction-header">
        <div>
          {onBack ? <Button type="button" variant="ghost" size="sm" onClick={onBack}><ArrowLeft aria-hidden="true" />Back to BOQ items</Button> : null}
          <span className="review-eyebrow">Evidence review</span>
          <h2 id="focused-extraction-title">Compound-cell extraction</h2>
          <p>Nothing changes until you accept a validated correction.</p>
        </div>
        <div className="extraction-review-heading-actions">
          {bulkProposalIds.length > 0 && !readOnly ? <Button type="button" size="sm" onClick={() => void acceptAll()} disabled={busy || Boolean(mutationBlockedReason)}><Check aria-hidden="true" />Accept all validated high-confidence</Button> : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void runReview()} disabled={readOnly || !extractionRunId || busy}>{loading || reviewRunStatus === "running" ? <Loader2 className="animate-spin" /> : <Sparkles aria-hidden="true" />}{reviewRunStatus === "running" ? "AI review running" : "Recheck with AI"}</Button>
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
        <div className={`extraction-review-result ${review.mode}`} role="status">
          <div className="extraction-review-result-copy"><strong>{reviewTitle(review)}</strong><span>{review.message}</span></div>
          <div className="extraction-review-result-counts">
            {review.rejectedProposals.length > 0 ? <small>{review.rejectedProposals.length} unsafe suggestion{review.rejectedProposals.length === 1 ? "" : "s"} blocked by server validation.</small> : null}
            {review.remainingCandidateRowIds.length > 0 ? <small>{review.remainingCandidateRowIds.length} additional candidate row{review.remainingCandidateRowIds.length === 1 ? "" : "s"} remain for follow-up.</small> : null}
          </div>
        </div>
      ) : null}

      {review?.remainingCandidateRowIds.length ? <div className="extraction-remaining-rows" aria-label="Additional candidate source rows"><span>Follow-up rows:</span>{review.remainingCandidateRowIds.map((sourceRowId) => <button type="button" key={sourceRowId} onClick={() => void runReview(sourceRowId)} disabled={readOnly || busy}>{sourceRowId}</button>)}</div> : null}

      {error ? <div className="review-save-error" role="alert">{error}</div> : null}

      {mutationBlockedReason ? <div className="review-save-error" role="status"><strong>Save draft before applying or undoing extraction corrections</strong><span>{mutationBlockedReason}</span></div> : null}

      {review?.mode === "ai" && review.proposals.length === 0 ? <div className="extraction-review-empty"><Check aria-hidden="true" /><strong>No correction proposals</strong><span>The deterministic BOQ remains unchanged. You can recheck an individual source row below.</span></div> : null}

      {review && (review.proposals.length > 0 || review.sourceRows.length > 0) ? (
        <div className="extraction-review-filters" role="group" aria-label="Filter extraction proposals">
          {REVIEW_FILTERS.map((filter) => <button type="button" className={state.filter === filter.value ? "filter-chip active" : "filter-chip"} aria-pressed={state.filter === filter.value} key={filter.value} onClick={() => dispatch({ type: "set_filter", filter: filter.value })}>{filter.label}</button>)}
        </div>
      ) : null}

      {review?.proposals.length ? (
        <div className="extraction-proposal-list" aria-label="Extraction review proposals">
          {visibleProposals.map((proposal) => {
            const status = statuses[proposal.id]
            const action = actions[proposal.id]
            const sourceRows = review.sourceRows.filter((row) => proposal.sourceRowIds.includes(row.sourceRowId))
            const canAccept = proposalCanBeAccepted(proposal) && !status
            const humanReview = proposal.operation === "needs_human_review"
            const expanded = state.expandedProposalIds[proposal.id] !== false
            return (
              <article className={`extraction-proposal focused ${status ? `is-${status}` : ""}`} key={proposal.id}>
                <div className="extraction-proposal-labels">
                  <span className={`extraction-operation ${proposal.operation}`}>{proposal.operation.replaceAll("_", " ")}</span>
                  <span className={proposalIsHighConfidence(proposal) ? "extraction-confidence high" : "extraction-confidence"}>{Math.round(proposal.confidence * 100)}% confidence</span>
                  <span className="extraction-validated">Validated evidence</span>
                </div>
                <p>{proposal.explanation}</p>
                <button type="button" className="extraction-proposal-expand" aria-expanded={expanded} onClick={() => dispatch({ type: "toggle_expanded", proposalId: proposal.id })}>{expanded ? "Hide evidence" : "Compare source and proposal"}</button>
                {expanded ? <div className="extraction-structure-grid">
                  <div className="extraction-original-list">{sourceRows.map((source) => <SourceEvidence key={source.sourceRowId} source={source} onNavigateToPage={onNavigateToPage} onRecheck={(sourceRowId) => void runReview(sourceRowId)} disabled={readOnly || busy} />)}<CurrentStructure boq={boq} proposal={proposal} /></div>
                  <ProposedStructure proposal={proposal} />
                </div> : null}
                <div className="extraction-validation-summary"><strong>Validation & reconciliation</strong><span><Check aria-hidden="true" />Source evidence valid</span><span><Check aria-hidden="true" />Arithmetic reconciled</span>{proposal.stale ? <span><X aria-hidden="true" />Proposal is stale</span> : null}</div>
                <div className="extraction-proposal-footer">
                  {humanReview ? <span className="extraction-human-review"><TriangleAlert aria-hidden="true" />Needs human review · acceptance disabled</span> : <span />}
                  <div className="extraction-proposal-actions">
                    {status === "accepted" && state.proposalCanUndo[proposal.id] && !readOnly ? <Button type="button" variant="outline" size="sm" onClick={() => void executeAction(proposal, "undo")} disabled={Boolean(action) || Boolean(mutationBlockedReason)}>Undo{action === "undoing" ? <Loader2 className="animate-spin" /> : <Undo2 aria-hidden="true" />}</Button> : null}
                    {!status ? <>
                      <Button type="button" size="sm" onClick={() => void executeAction(proposal, "accept")} disabled={readOnly || Boolean(mutationBlockedReason) || !canAccept || Boolean(action)}>Accept{action === "accepting" ? <Loader2 className="animate-spin" /> : <Check aria-hidden="true" />}</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void executeAction(proposal, "reject")} disabled={readOnly || Boolean(action)}>Reject{action === "rejecting" ? <Loader2 className="animate-spin" /> : <X aria-hidden="true" />}</Button>
                    </> : status !== "accepted" ? <span className="extraction-action-status">{status === "rejected" ? "Rejected" : "Undone"}</span> : null}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : null}

      {filteredRowsWithoutProposal.length ? <div className="extraction-reviewed-source-list" aria-label="Filtered source rows without proposals"><strong>Source rows awaiting review</strong>{filteredRowsWithoutProposal.map((source) => <SourceEvidence key={source.sourceRowId} source={source} onNavigateToPage={onNavigateToPage} onRecheck={(sourceRowId) => void runReview(sourceRowId)} disabled={readOnly || busy} />)}</div> : null}

      {review?.sourceRows.length && review.proposals.length === 0 ? (
        <div className="extraction-reviewed-source-list" aria-label="Reviewed source rows">
          {review.sourceRows.map((source) => <SourceEvidence key={source.sourceRowId} source={source} onNavigateToPage={onNavigateToPage} onRecheck={(sourceRowId) => void runReview(sourceRowId)} disabled={readOnly || busy} />)}
        </div>
      ) : null}
    </section>
  )
}
