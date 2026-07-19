"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { StandardizationReview } from "./standardization-review"
import { Check, Eye, ExternalLink, Loader2, TriangleAlert, X } from "lucide-react"
import { toast } from "sonner"
import type { Boq, BoqItem, WorkType } from "@/lib/boq-schema"
import {
  parseVerificationApiResponse,
  type AiFallbackResponse,
  type AiSuccessResponse,
  type VerificationResponseIssue,
} from "@/lib/boq-verification"
import {
  buildReviewFingerprint,
  buildReviewVerification,
  reviewItemKey,
  updateReviewItem,
  type ReviewItemField,
} from "@/lib/boq-review-state"
import { deriveSourceCostAllocation } from "@/lib/boq-cost-allocation"
import { getBoqCatalogReadiness } from "@/lib/boq-catalog-readiness"
import { getBoqItemRequestIdentity } from "@/lib/boq-item-identity"
import { CatalogMatchModal } from "./catalog-match-modal"
import { calculateBoqTotals, isPricedBoqItem } from "@/lib/boq-pricing"

interface ReviewPanelProps {
  boq: Boq
  onClose: () => void
  onApproved: (boq: Boq) => void
  primaryActionLabel?: string
  requireCatalogReadiness?: boolean
}

type VerificationApiResponse = AiSuccessResponse | AiFallbackResponse

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === "string") return body.error
  } catch {
    // Use the safe fallback for non-JSON server responses.
  }
  return fallback
}

function confidenceLabel(value: number | undefined): string | null {
  if (typeof value !== "number") return null
  return `${Math.round(value * 100)}% confidence`
}

function sourceRowKey(item: BoqItem): string | null {
  const ref = item.sourceRef
  return ref ? `${ref.page}:${ref.table}:${ref.row}` : null
}

function verificationIssueTarget(issue: VerificationResponseIssue, items: BoqItem[]): string | null {
  const index = issue.itemId
    ? items.findIndex((item) => item.id === issue.itemId)
    : typeof issue.itemIndex === "number" ? issue.itemIndex : -1
  if (index >= 0 && items[index]) return `Item ${index + 1}: ${items[index].desc}`
  return issue.itemId ? `Item ID: ${issue.itemId}` : null
}

function sectionsWithItems(boq: Boq, items: BoqItem[]): Boq["sections"] {
  let offset = 0
  return boq.sections.map((section) => {
    const sectionItems = items.slice(offset, offset + section.items.length)
    offset += section.items.length
    return { ...section, items: sectionItems }
  })
}

function sectionIndexForItem(boq: Boq, itemIndex: number): number {
  let offset = 0
  for (let sectionIndex = 0; sectionIndex < boq.sections.length; sectionIndex += 1) {
    offset += boq.sections[sectionIndex].items.length
    if (itemIndex < offset) return sectionIndex
  }
  return -1
}

export function ReviewPanel({ boq, onClose, onApproved, primaryActionLabel = "Approve & Save", requireCatalogReadiness = false }: ReviewPanelProps) {
  const [items, setItems] = useState<BoqItem[]>(() => boq.sections.flatMap((section) => section.items))
  const [vendor, setVendor] = useState(boq.vendor)
  const [project, setProject] = useState(boq.project)
  const [workType, setWorkType] = useState<WorkType>(boq.workType)
  const [date, setDate] = useState(boq.date)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [approveLoading, setApproveLoading] = useState(false)
  const [verificationState, setVerificationState] = useState<{
    fingerprint: string
    result: VerificationApiResponse
  } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [sourceAttempt, setSourceAttempt] = useState(0)
  const [sourcePreviewFailed, setSourcePreviewFailed] = useState(false)
  const [catalogMatchIndex, setCatalogMatchIndex] = useState<number | null>(null)
  const [catalogBusyIndex, setCatalogBusyIndex] = useState<number | null>(null)
  const reviewPanelRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const reviewSections = useMemo(() => sectionsWithItems(boq, items), [boq, items])
  const grandTotal = useMemo(() => calculateBoqTotals(reviewSections).grandTotal, [reviewSections])
  const catalogReadiness = useMemo(
    () => getBoqCatalogReadiness({ sections: reviewSections }),
    [reviewSections],
  )
  const hasSource = boq.sourceAvailable ?? Boolean(boq.sourceFileName)
  const sourceBaseUrl = `/api/boqs/${encodeURIComponent(boq.id)}/source`
  const sourceUrl = sourceAttempt > 0 ? `${sourceBaseUrl}?retry=${sourceAttempt}` : sourceBaseUrl
  const sourceRowCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const key = sourceRowKey(item)
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [items])
  const reviewEdits = useMemo(() => ({
    vendor,
    project,
    workType,
    date,
    items,
  }), [date, items, project, vendor, workType])
  const reviewFingerprint = useMemo(() => buildReviewFingerprint(reviewEdits), [reviewEdits])
  const verificationResult = verificationState?.fingerprint === reviewFingerprint
    ? verificationState.result
    : null
  const llmVerified = verificationResult?.mode === "ai"
  const verification = useMemo(() => buildReviewVerification(boq, reviewEdits), [boq, reviewEdits])
  const blockingIssues = verification.issues.filter((issue) => issue.severity === "blocking")
  const localWarnings = verification.issues.filter((issue) => issue.severity === "warning")
  const busy = verifyLoading || approveLoading

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    reviewPanelRef.current?.querySelector<HTMLElement>("[data-review-initial-focus]")?.focus()
    return () => previousFocusRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busy) {
        onClose()
        return
      }
      if (event.key !== "Tab") return
      const focusable = Array.from(
        reviewPanelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((element) => element.getAttribute("aria-hidden") !== "true")
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!reviewPanelRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [busy, onClose])

  const handleItemChange = useCallback((idx: number, field: ReviewItemField, value: string | number) => {
    setSaveError(null)
    setItems((current) => updateReviewItem(current, idx, field, value))
  }, [])

  const handleExcludeRequest = useCallback(async (item: BoqItem, itemIndex: number, reason: string) => {
    const sectionIndex = sectionIndexForItem(boq, itemIndex)
    if (sectionIndex < 0) return false
    setCatalogBusyIndex(itemIndex)
    setSaveError(null)
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionIndex, items: [{ ...getBoqItemRequestIdentity(item), stdStatus: "excluded", stdExclusionReason: reason.trim() }] }),
      })
      if (!response.ok) throw new Error(await readError(response, "The item could not be excluded."))
      setItems((current) => current.map((candidate, index) => {
        if (index !== itemIndex) return candidate
        const next = { ...candidate, stdStatus: "excluded" as const, stdExclusionReason: reason.trim() }
        delete next.stdId
        delete next.stdMatch
        delete next.stdConfidence
        return next
      }))
      toast.success("Item excluded from catalog comparison")
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : "The item could not be excluded."
      setSaveError(message)
      toast.error(message)
      return false
    } finally {
      setCatalogBusyIndex(null)
    }
  }, [boq])

  const handleVerify = async () => {
    setVerifyLoading(true)
    const requestedFingerprint = reviewFingerprint
    try {
      const response = await fetch("/api/llm/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boqId: boq.id,
          vendor,
          project,
          workType,
          date,
          sourceTotal: boq.sourceTotal,
          items: items.filter(isPricedBoqItem).map((item) => ({
            ...(item.id ? { id: item.id } : {}),
            desc: item.desc,
            unit: item.unit,
            qty: item.qty,
            rate: item.rate,
            total: item.total,
          })),
          extractionWarnings: (boq.extractionWarnings ?? []).map((warning) => ({
            code: warning.code,
            message: warning.message,
          })),
        }),
      })
      const rawPayload: unknown = await response.json().catch(() => null)
      const payload = parseVerificationApiResponse(rawPayload)
      if (!payload) {
        const error = typeof rawPayload === "object" && rawPayload !== null && "error" in rawPayload
          ? (rawPayload as { error?: unknown }).error
          : null
        throw new Error(typeof error === "string" ? error : "Verification failed")
      }
      setVerificationState({ fingerprint: requestedFingerprint, result: payload })
      if (payload.mode === "ai") toast.success("AI verification complete")
      else toast.warning(payload.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification request failed")
    } finally {
      setVerifyLoading(false)
    }
  }

  const handleApprove = async () => {
    if (verification.hasBlockingIssues) return
    setApproveLoading(true)
    setSaveError(null)
    try {
      const sections = reviewSections
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          vendor,
          workType,
          date,
          status: "approved",
          sections,
        }),
      })
      if (!response.ok) throw new Error(await readError(response, "The BOQ could not be saved. Try again."))
      const updated = await response.json() as Boq
      const reviewCount = items.filter((item) => item.stdStatus !== "matched").length
      toast.success(reviewCount > 0
        ? `BOQ approved · ${reviewCount} ${reviewCount === 1 ? "item" : "items"} sent to Catalog review`
        : "BOQ approved and linked to the Standard Catalog")
      onApproved(updated)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : "The BOQ could not be saved. Try again."
      setSaveError(message)
      toast.error(message)
    } finally {
      setApproveLoading(false)
    }
  }

  const confidence = boq.metadataConfidence
  const retrySourcePreview = () => {
    setSourcePreviewFailed(false)
    setSourceAttempt((attempt) => attempt + 1)
  }

  return (
    <div className="modal-overlay review-overlay open" data-od-id="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title">
      <div ref={reviewPanelRef} className="review-panel" data-od-id="review-panel">
        <header className="review-header">
          <div className="review-header-title">
            <Eye className="w-5 h-5 text-accent" />
            <div>
              <span id="review-dialog-title" className="review-title">Review BOQ</span>
              <span className="review-subtitle">{project || "Untitled"}</span>
            </div>
          </div>
          <div className="review-header-actions">
            <span className="review-parsed-badge">Docling parsed</span>
            <Button data-review-initial-focus variant="ghost" size="icon-sm" onClick={onClose} disabled={busy} aria-label="Close BOQ review">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </header>

        <div className="review-body">
          <section className="review-pdf-col" data-od-id="review-pdf-panel" aria-label="Original BOQ PDF">
            <div className="review-panel-toolbar">
              <span className="review-panel-label"><Eye className="w-3.5 h-3.5" />Original BOQ PDF</span>
              <span className="review-source-filename" title={boq.sourceFileName}>{boq.sourceFileName || "source.pdf"}</span>
            </div>
            {!hasSource ? (
              <div className="review-pdf-fallback" role="alert">
                <TriangleAlert aria-hidden="true" />
                <strong>No source PDF is available for this legacy BOQ.</strong>
                <span>The BOQ was created before source files were retained.</span>
              </div>
            ) : sourcePreviewFailed ? (
              <div className="review-pdf-fallback" role="alert">
                <TriangleAlert aria-hidden="true" />
                <strong>The PDF preview could not be loaded.</strong>
                <span>{boq.sourceFileName || "source.pdf"}</span>
                <Button type="button" variant="outline" size="sm" onClick={retrySourcePreview}>Retry preview</Button>
                <a href={sourceUrl} target="_blank" rel="noreferrer">Open PDF <ExternalLink aria-hidden="true" /></a>
              </div>
            ) : (
              <object
                key={sourceAttempt}
                className="review-pdf-object"
                data={sourceUrl}
                type="application/pdf"
                aria-label={`Source PDF: ${boq.sourceFileName || "source.pdf"}`}
                onError={() => setSourcePreviewFailed(true)}
              >
                <div className="review-pdf-fallback" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <strong>PDF preview isn’t available in this browser.</strong>
                  <span>{boq.sourceFileName || "source.pdf"}</span>
                  <Button type="button" variant="outline" size="sm" onClick={retrySourcePreview}>Retry preview</Button>
                  <a href={sourceUrl} target="_blank" rel="noreferrer">Open PDF <ExternalLink aria-hidden="true" /></a>
                </div>
              </object>
            )}
          </section>

          <div className="review-resize-handle" aria-hidden="true"><span /></div>

          <section className="review-data-col" data-od-id="review-data-panel">
            <div className="review-metadata">
              <h3 className="text-sm font-medium mb-3">BOQ Details</h3>
              <div className="grid grid-cols-2 gap-3">
                {([
                  ["revVendor", "Vendor", vendor, setVendor, confidenceLabel(confidence?.vendor)],
                  ["revProject", "Project", project, setProject, confidenceLabel(confidence?.project)],
                ] as const).map(([id, label, value, setter, confidenceText]) => (
                  <div className="space-y-1" key={id}>
                    <label htmlFor={id} className="review-field-label"><span>{label}</span>{confidenceText ? <small>{confidenceText}</small> : null}</label>
                    <Input id={id} value={value} onChange={(event) => { setSaveError(null); setter(event.target.value) }} />
                  </div>
                ))}
                <div className="space-y-1">
                  <label id="revWorkTypeLabel" className="review-field-label"><span>Work Type</span>{confidenceLabel(confidence?.workType) ? <small>{confidenceLabel(confidence?.workType)}</small> : null}</label>
                  <Select value={workType} onValueChange={(value) => { setSaveError(null); setWorkType(value as WorkType) }}>
                    <SelectTrigger aria-labelledby="revWorkTypeLabel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Unclassified">Unclassified</SelectItem>
                      <SelectItem value="Structural">Structural</SelectItem>
                      <SelectItem value="MEP">MEP</SelectItem>
                      <SelectItem value="Finishing">Finishing</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label htmlFor="revDate" className="review-field-label"><span>Document Date</span>{confidenceLabel(confidence?.date) ? <small>{confidenceLabel(confidence?.date)}</small> : null}</label>
                  <Input id="revDate" type="date" value={date} onChange={(event) => { setSaveError(null); setDate(event.target.value) }} />
                </div>
              </div>
            </div>

            {boq.extractionWarnings?.length ? (
              <div className="review-warning-list" role="status">
                <strong>Document extraction notes</strong>
                {boq.extractionWarnings.map((warning, index) => <span key={`${warning.code}-${index}`}>{warning.message}</span>)}
              </div>
            ) : null}

            <div className="review-items-heading">
              <span className="text-sm font-medium">Parsed Items · {items.length} line items</span>
              <span className="font-mono text-sm">Grand Total: ฿{grandTotal.toLocaleString()}</span>
            </div>
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="review-items-table" data-od-id="review-items-table">
                <thead><tr>
                  <th>Description</th><th>Unit</th><th className="num-col">Qty</th><th className="num-col">Rate (฿)</th><th className="num-col">Material</th><th className="num-col">Labour</th><th className="num-col">Total</th><th>Std</th>
                </tr></thead>
                <tbody>
                  {items.map((item, idx) => {
                    const rowKey = sourceRowKey(item)
                    if (!isPricedBoqItem(item)) {
                      return (
                        <tr key={reviewItemKey(boq.id, item, idx)} data-ri={idx} className="bg-muted/20 text-muted-foreground">
                          <td className="pl-5">
                            <span className="mr-2 inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">Included</span>
                            {item.desc}
                          </td>
                          <td colSpan={6}>Informational bundle component · pricing is held by the parent item</td>
                          <td><span className="review-std-badge pending">Info</span></td>
                        </tr>
                      )
                    }
                    const showComponent = Boolean(rowKey && (sourceRowCounts.get(rowKey) ?? 0) > 1 && item.costComponent)
                    const allocation = deriveSourceCostAllocation(item)
                    return (
                      <tr key={reviewItemKey(boq.id, item, idx)} data-ri={idx}>
                        <td>
                          <Input aria-label={`Description for item ${idx + 1}`} value={item.desc} onChange={(event) => handleItemChange(idx, "desc", event.target.value)} />
                          {showComponent ? <span className="review-component-badge">{item.costComponent}</span> : null}
                          {item.extractionWarnings?.map((warning, warningIndex) => <span className="review-item-warning" key={`${warning.code}-${warningIndex}`}>{warning.message}</span>)}
                        </td>
                        <td><Input aria-label={`Unit for item ${idx + 1}`} value={item.unit} onChange={(event) => handleItemChange(idx, "unit", event.target.value)} /></td>
                        <td><Input aria-label={`Quantity for item ${idx + 1}`} type="number" value={item.qty} onChange={(event) => handleItemChange(idx, "qty", Number(event.target.value))} /></td>
                        <td><Input aria-label={`Rate for item ${idx + 1}`} type="number" value={item.rate} onChange={(event) => handleItemChange(idx, "rate", Number(event.target.value))} /></td>
                        <td className="num-col font-mono" title={allocation ? `${allocation.origin} ${allocation.basis}` : "No reliable split in source"}>{allocation ? `฿${allocation.material.toLocaleString()}` : "Not split"}</td>
                        <td className="num-col font-mono" title={allocation ? `${allocation.origin} ${allocation.basis}` : "No reliable split in source"}>{allocation ? `฿${allocation.labour.toLocaleString()}` : "Not split"}</td>
                        <td className="num-col font-mono">฿{item.total.toLocaleString()}</td>
                        <td><span className={`review-std-badge ${item.stdStatus}`}>{item.stdStatus === "matched" ? "Matched" : item.stdStatus === "excluded" ? "Excluded" : item.stdStatus === "pending" ? "Suggested" : "—"}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {requireCatalogReadiness ? (
              <div className="rounded-lg border border-accent/25 bg-accent/5 p-3" data-od-id="catalog-readiness">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <strong>Catalog readiness</strong>
                  <span className="font-mono">{catalogReadiness.resolved}/{catalogReadiness.total} resolved</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${catalogReadiness.total ? (catalogReadiness.resolved / catalogReadiness.total) * 100 : 100}%` }} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Match an existing item, create a catalog entry, or exclude a one-off line with a reason before approval.</p>
              </div>
            ) : null}

            <StandardizationReview
              items={items}
              onItemsChange={setItems}
              onMatchRequest={requireCatalogReadiness ? (_item, index) => setCatalogMatchIndex(index) : undefined}
              onExcludeRequest={requireCatalogReadiness ? handleExcludeRequest : undefined}
              catalogBusyIndex={catalogBusyIndex}
            />

            {localWarnings.length ? (
              <div className="review-warning-list review-local-warnings" role="status">
                <strong>Review recommended</strong>
                {localWarnings.map((warning, index) => <span key={`${warning.code}-${warning.itemId ?? warning.itemIndex ?? index}`}>{warning.message}</span>)}
              </div>
            ) : null}

            {blockingIssues.length ? (
              <div className="review-blockers" role="alert">
                <strong>Resolve before approval</strong>
                <ul>{blockingIssues.map((issue, index) => <li key={`${issue.code}-${issue.itemId ?? issue.itemIndex ?? index}`}>{issue.message}</li>)}</ul>
              </div>
            ) : null}
            {saveError ? <div className="review-save-error" role="alert">{saveError}</div> : null}

            {verificationResult ? (
              <div className="review-warning-list review-local-warnings" role="status">
                <strong>{verificationResult.message}</strong>
                <span>{verificationResult.issues.length} verification {verificationResult.issues.length === 1 ? "issue" : "issues"}</span>
                <ul aria-label="Verification findings">
                  {verificationResult.issues.map((issue, index) => {
                    const target = verificationIssueTarget(issue, items)
                    return (
                      <li key={`${issue.code}-${issue.itemId ?? issue.itemIndex ?? "document"}-${index}`}>
                        <span className={`review-verification-severity ${issue.severity}`}>{issue.severity}</span>
                        <span>{issue.message}</span>
                        {target ? <small>{target}</small> : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}

            <div className="review-verification-row">
              <span>Docling parsed <strong>{items.length}</strong> line items</span>
              <Button variant="ghost" size="sm" onClick={handleVerify} disabled={verifyLoading || llmVerified}>
                {verifyLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : llmVerified ? <Check className="w-3 h-3" /> : null}
                {llmVerified
                  ? "Verified with AI"
                  : verificationResult?.mode === "local"
                    ? "Retry AI verification"
                    : "Verify with AI"}
              </Button>
            </div>
            <div className="review-actions">
              <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Discard</Button>
              <Button size="sm" onClick={handleApprove} disabled={approveLoading || verification.hasBlockingIssues || (requireCatalogReadiness && catalogReadiness.blocking > 0)}>
                {approveLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                {primaryActionLabel}
              </Button>
            </div>
          </section>
        </div>
        {catalogMatchIndex !== null && items[catalogMatchIndex] && isPricedBoqItem(items[catalogMatchIndex]) ? (
          <CatalogMatchModal
            itemDesc={items[catalogMatchIndex].desc}
            itemUnit={items[catalogMatchIndex].unit}
            itemCode={items[catalogMatchIndex].code}
            sourceProject={project}
            sourceVendor={vendor}
            matchContext={{
              boqId: boq.id,
              sectionIndex: sectionIndexForItem(boq, catalogMatchIndex),
              ...getBoqItemRequestIdentity(items[catalogMatchIndex]),
            }}
            onClose={() => setCatalogMatchIndex(null)}
            onMatch={async (standardId, standardDescription, standardUnit) => {
              setItems((current) => current.map((candidate, index) => {
                if (index !== catalogMatchIndex || !isPricedBoqItem(candidate)) return candidate
                return {
                  ...candidate,
                  sourceDesc: candidate.sourceDesc ?? candidate.desc,
                  sourceUnit: candidate.sourceUnit ?? candidate.unit,
                  desc: standardDescription,
                  unit: standardUnit,
                  stdId: standardId,
                  stdMatch: standardDescription,
                  stdStatus: "matched",
                  stdConfidence: "manual",
                  stdExclusionReason: undefined,
                }
              }))
              setCatalogMatchIndex(null)
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
