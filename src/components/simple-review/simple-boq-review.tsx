"use client"

import dynamic from "next/dynamic"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, ChevronDown, Info, Loader2, RotateCcw, Search, Sparkles, X } from "lucide-react"
import { toast } from "sonner"

import { ExtractionReview } from "@/components/extraction-review"
import { ProtoBadge } from "@/components/proto-badge"
import { ReviewWorkspace } from "@/components/review-workspace"
import { Button } from "@/components/ui/button"
import { isPricedBoqItem } from "@/lib/boq-pricing"
import { buildCanonicalRevisionKey } from "@/lib/boq-review-state"
import type { Boq, BoqItem, BoqPricedItem, WorkType } from "@/lib/boq-schema"
import { parseVerificationApiResponse, type AiFallbackResponse, type AiSuccessResponse } from "@/lib/boq-verification"
import { loadInlineCatalogSources } from "@/components/use-inline-catalog-matching"
import {
  buildApprovalChoices,
  buildQuoteNotes,
  buildRowFlags,
  preselectCatalog,
  rowKey,
  rowSourceRef,
  searchCatalog,
  type CatalogPick,
  type ReviewIssue,
} from "@/lib/simple-review"
import type { StandardEntry } from "@/lib/standard-schema"

const PdfReviewViewer = dynamic(
  () => import("@/components/pdf-review-viewer").then((m) => m.PdfReviewViewer),
  { ssr: false, loading: () => <div className="pdf-review-loading" role="status" aria-label="Loading PDF viewer">…</div> },
)

const WORK_TYPES: WorkType[] = ["Structural", "MEP", "Finishing", "Unclassified"]

type AiCheck =
  | { state: "running" }
  | { state: "done"; result: AiSuccessResponse | AiFallbackResponse }
  | { state: "failed"; message: string }

type Meta = Pick<Boq, "vendor" | "project" | "date" | "workType">

const AI_NOT_RUN_REASON: Record<AiFallbackResponse["aiStatus"], string> = {
  provider_not_configured: "no AI key is set up",
  unsupported_provider: "the AI provider is not supported",
  unauthorized: "the AI key was rejected",
  rate_limited: "the AI service is busy",
  timeout: "the AI service took too long",
  malformed_response: "the AI reply could not be read",
  provider_failure: "the AI service failed",
}

function money(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"
}

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim()
  if (cleaned === "") return null
  const value = Number(cleaned)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

const MISSING_PROJECT = "Add a project name (top left). Prices are saved under it."

/** Server checks speak in field names; say it plainly. */
function plainBlocking(text: string): string {
  const missing = /^(project|vendor|date|workType) is required$/i.exec(text.trim())
  if (!missing) return text
  const field = missing[1]!.toLowerCase()
  if (field === "project") return MISSING_PROJECT
  return `Add the ${field === "worktype" ? "work type" : field} (top left).`
}

async function readError(response: Response, fallback: string): Promise<{ message: string; blocking?: string[] }> {
  try {
    const body = (await response.json()) as { error?: unknown; blocking?: unknown }
    const blocking = Array.isArray(body.blocking)
      ? body.blocking.map((entry) => (typeof entry === "string" ? entry : typeof entry === "object" && entry && "message" in entry ? String((entry as { message: unknown }).message) : "")).filter(Boolean)
      : undefined
    return { message: typeof body.error === "string" ? body.error : fallback, blocking }
  } catch {
    return { message: fallback }
  }
}

export function SimpleBoqReview({ boq, onBoqChange }: { boq: Boq; onBoqChange: (boq: Boq) => void }) {
  const approved = boq.status === "approved"
  const hasSource = boq.sourceAvailable ?? Boolean(boq.sourceFileName)
  const [sections, setSections] = useState(boq.sections)
  const [meta, setMeta] = useState<Meta>({ vendor: boq.vendor, project: boq.project, date: boq.date, workType: boq.workType })
  const [dirty, setDirty] = useState(false)
  const [catalog, setCatalog] = useState<{ standards: StandardEntry[]; unitMap: Record<string, string> } | null>(null)
  const [chosen, setChosen] = useState<{ revision: string; picks: Map<string, CatalogPick> }>({ revision: boq.updatedAt, picks: new Map() })
  const [aiCheck, setAiCheck] = useState<AiCheck | null>(null)
  const [focus, setFocus] = useState<{ page: number; table: number; row: number; key: number }>({ page: 1, table: 0, row: 0, key: 0 })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pickerKey, setPickerKey] = useState<string | null>(null)
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const [busy, setBusy] = useState<"approve" | "reopen" | null>(null)
  const [blocking, setBlocking] = useState<string[]>([])
  const [missedCount, setMissedCount] = useState(0)
  const draft = useMemo(() => ({ ...boq, ...meta, sections }), [boq, meta, sections])

  // Reset local state when the server copy changes (approve, reopen, AI row fixes).
  const lastRevision = useRef(boq.updatedAt)
  useEffect(() => {
    if (lastRevision.current === boq.updatedAt) return
    lastRevision.current = boq.updatedAt
    setSections(boq.sections)
    setMeta({ vendor: boq.vendor, project: boq.project, date: boq.date, workType: boq.workType })
    setDirty(false)
  }, [boq])

  useEffect(() => {
    const controller = new AbortController()
    loadInlineCatalogSources(fetch, controller.signal)
      .then((sources) => setCatalog(sources))
      .catch(() => { if (!controller.signal.aborted) setCatalog({ standards: [], unitMap: {} }) })
    return () => controller.abort()
  }, [])

  // Pre-select the best catalog item for every row from the server copy; the user's
  // own choices for this revision sit on top.
  const picks = useMemo(() => {
    const base = catalog ? preselectCatalog(boq, catalog.standards, catalog.unitMap) : new Map<string, CatalogPick>()
    if (chosen.revision === boq.updatedAt) for (const [key, pick] of chosen.picks) base.set(key, pick)
    return base
  }, [boq, catalog, chosen])
  const choosePick = (key: string, pick: CatalogPick) => setChosen((current) => ({
    revision: boq.updatedAt,
    picks: new Map(current.revision === boq.updatedAt ? current.picks : []).set(key, pick),
  }))

  const runAiCheck = useCallback(async (source: Boq) => {
    setAiCheck({ state: "running" })
    try {
      const response = await fetch("/api/llm/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boqId: source.id,
          vendor: source.vendor,
          project: source.project,
          workType: source.workType,
          date: source.date,
          sourceTotal: source.sourceTotal,
          items: source.sections.flatMap((section) => section.items).filter(isPricedBoqItem).map((item) => ({
            ...(item.id ? { id: item.id } : {}),
            desc: item.desc, unit: item.unit, qty: item.qty, rate: item.rate, total: item.total,
            optional: item.optional === true, excludedFromTotal: item.excludedFromTotal === true,
          })),
          extractionWarnings: (source.extractionWarnings ?? []).map((warning) => ({ code: warning.code, message: warning.message })),
        }),
      })
      const result = parseVerificationApiResponse(await response.json().catch(() => null))
      setAiCheck(result ? { state: "done", result } : { state: "failed", message: "The check returned an unexpected reply." })
    } catch {
      setAiCheck({ state: "failed", message: "The check could not be reached." })
    }
  }, [])

  // Run the whole-quote check automatically once per quote revision.
  const checkedRevision = useRef<string | null>(null)
  useEffect(() => {
    if (approved || checkedRevision.current === boq.updatedAt) return
    checkedRevision.current = boq.updatedAt
    void runAiCheck(boq)
  }, [approved, boq, runAiCheck])

  const issues: ReviewIssue[] = useMemo(() => (aiCheck?.state === "done" ? aiCheck.result.issues : []), [aiCheck])
  const rowFlags = useMemo(() => buildRowFlags(draft, issues.filter((issue) => issue.itemId)), [draft, issues])
  const quoteNotes = useMemo(() => {
    const keys = new Set<string>()
    const ids = new Set<string>()
    draft.sections.forEach((section, si) => section.items.forEach((item, ii) => { keys.add(rowKey(si, ii)); if (item.id) ids.add(item.id) }))
    const notes = buildQuoteNotes(issues.filter((issue) => issue.itemIndex === undefined), keys, ids)
    for (const warning of boq.extractionWarnings ?? []) {
      if (warning.code === "document_total_mismatch" || warning.code === "document_summary_mismatch") {
        const text = "Sum of rows does not match the total printed on the PDF."
        if (!notes.includes(text)) notes.push(text)
      }
    }
    return notes
  }, [boq.extractionWarnings, draft.sections, issues])

  const standardsById = useMemo(() => new Map((catalog?.standards ?? []).map((standard) => [standard.id, standard])), [catalog])
  const totals = useMemo(() => {
    let sum = 0
    let rows = 0
    for (const section of sections) for (const item of section.items) {
      if (!isPricedBoqItem(item)) continue
      rows += 1
      if (item.excludedFromTotal !== true) sum += item.total
    }
    return { sum: round2(sum), rows }
  }, [sections])
  const linkedCount = useMemo(() => [...picks.values()].filter((pick) => pick.standardId).length, [picks])

  const editItem = (sectionIndex: number, itemIndex: number, patch: (item: BoqPricedItem) => BoqPricedItem) => {
    setSections((current) => current.map((section, si) => si !== sectionIndex ? section : {
      ...section,
      items: section.items.map((item, ii) => (ii === itemIndex && isPricedBoqItem(item) ? patch(item) : item)),
    }))
    setDirty(true)
  }

  const goToSource = (key: string, item: BoqItem) => {
    setSelectedKey(key)
    const ref = rowSourceRef(item)
    if (ref) setFocus((current) => ({ page: ref.page, table: ref.table, row: ref.row, key: current.key + 1 }))
  }

  const projectRef = useRef<HTMLInputElement>(null)
  const projectMissing = !approved && meta.project.trim() === ""

  const approve = async () => {
    if (projectMissing) {
      setBlocking([MISSING_PROJECT])
      projectRef.current?.focus()
      return
    }
    setBusy("approve")
    setBlocking([])
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...meta, sections, choices: buildApprovalChoices(draft, picks) }),
      })
      if (!response.ok) {
        const error = await readError(response, "Could not approve this quote.")
        setBlocking((error.blocking?.length ? error.blocking : [error.message]).map(plainBlocking))
        return
      }
      const body = (await response.json()) as { boq: Boq; linked: number; noCatalog: number }
      toast.success(`Approved. ${body.linked} ${body.linked === 1 ? "price" : "prices"} saved to price history.`)
      onBoqChange(body.boq)
    } catch {
      setBlocking(["Could not reach the server. Nothing was saved."])
    } finally {
      setBusy(null)
    }
  }

  const reopen = async () => {
    setBusy("reopen")
    try {
      const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/reopen`, { method: "POST" })
      if (!response.ok) {
        toast.error((await readError(response, "Could not reopen this quote.")).message)
        return
      }
      const body = (await response.json()) as { boq: Boq }
      toast.success("Reopened. Its prices are out of price history until you approve again.")
      checkedRevision.current = null
      onBoqChange(body.boq)
    } finally {
      setBusy(null)
    }
  }

  const flaggedCount = rowFlags.size
  const evidenceFocus = focus.key > 0 ? { page: focus.page, table: focus.table, row: focus.row, cells: [] } : undefined
  const rowNumbers = new Map<string, number>()
  sections.forEach((section, si) => section.items.forEach((item, ii) => { if (isPricedBoqItem(item)) rowNumbers.set(rowKey(si, ii), rowNumbers.size + 1) }))

  return (
    <div className="review-embedded boq-unified-workspace simple-review" data-od-id="boq-detail">
      <div className="review-panel">
        <header className="simple-review-header">
          <div className="simple-review-title">
            <Link href="/boqs" className="simple-review-back" aria-label="Back to quotes">‹</Link>
            <input ref={projectRef} aria-label="Project" className={`simple-review-meta simple-review-project${projectMissing ? " is-missing" : ""}`} value={meta.project} disabled={approved} placeholder="Project name (needed)" aria-invalid={projectMissing || undefined}
              onChange={(e) => { setMeta({ ...meta, project: e.target.value }); setDirty(true) }} />
            <input aria-label="Vendor" className="simple-review-meta" value={meta.vendor} disabled={approved} placeholder="Vendor"
              onChange={(e) => { setMeta({ ...meta, vendor: e.target.value }); setDirty(true) }} />
            <input aria-label="Quote date" type="date" className="simple-review-meta simple-review-date" value={meta.date} disabled={approved}
              onChange={(e) => { setMeta({ ...meta, date: e.target.value }); setDirty(true) }} />
            <select aria-label="Work type" className="simple-review-meta" value={meta.workType} disabled={approved}
              onChange={(e) => { setMeta({ ...meta, workType: e.target.value as WorkType }); setDirty(true) }}>
              {WORK_TYPES.map((type) => <option key={type} value={type}>{type === "Unclassified" ? "Work type…" : type}</option>)}
            </select>
            <ProtoBadge status={boq.status} />
          </div>
          <div className="simple-review-actions">
            <span className="simple-review-summary">
              {totals.rows} rows · total {money(totals.sum)}
              {boq.sourceTotal !== undefined && Math.abs(boq.sourceTotal - totals.sum) > 0.01 ? <span className="simple-review-warn"> (PDF says {money(boq.sourceTotal)})</span> : null}
            </span>
            {approved ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void reopen()} disabled={busy !== null}>
                {busy === "reopen" ? <Loader2 className="animate-spin" /> : <RotateCcw aria-hidden="true" />}Reopen to edit
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => void approve()} disabled={busy !== null || !catalog} data-testid="simple-approve">
                {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check aria-hidden="true" />}Approve
              </Button>
            )}
            <Link href={`/boqs/${encodeURIComponent(boq.id)}?classic=1`} className="simple-review-classic">Classic view</Link>
          </div>
        </header>

        <div className="simple-review-strip" role="status">
          {approved ? (
            <span><Check aria-hidden="true" /> Approved{boq.approvedAt ? ` ${new Date(boq.approvedAt).toLocaleString()}` : ""}. Its prices are in price history. Reopen to make changes.</span>
          ) : aiCheck?.state === "running" ? (
            <span><Loader2 className="animate-spin" aria-hidden="true" /> Checking the quote…</span>
          ) : aiCheck?.state === "done" && aiCheck.result.mode === "ai" ? (
            <span><Sparkles aria-hidden="true" /> AI check done ({aiCheck.result.model}). {flaggedCount ? `${flaggedCount} ${flaggedCount === 1 ? "row needs" : "rows need"} a look.` : "Nothing looks wrong."}</span>
          ) : aiCheck?.state === "done" && aiCheck.result.mode === "local" ? (
            <span className="simple-review-note"><Info aria-hidden="true" /> AI check didn’t run ({AI_NOT_RUN_REASON[aiCheck.result.aiStatus]}). Basic checks only. {flaggedCount ? `${flaggedCount} ${flaggedCount === 1 ? "row needs" : "rows need"} a look.` : ""}</span>
          ) : aiCheck?.state === "failed" ? (
            <span className="simple-review-note"><Info aria-hidden="true" /> AI check didn’t run ({aiCheck.message}). Basic checks only.</span>
          ) : null}
          {!approved && aiCheck?.state !== "running" ? <button type="button" className="simple-review-link" onClick={() => void runAiCheck(draft)}>Check again</button> : null}
          {flaggedCount ? (
            <label className="simple-review-filter"><input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Only rows that need a look ({flaggedCount})</label>
          ) : null}
          {catalog ? <span className="simple-review-muted">{linkedCount} of {totals.rows} matched to catalog</span> : <span className="simple-review-muted">Loading catalog…</span>}
          {dirty && !approved ? <span className="simple-review-muted">Edits are saved when you approve.</span> : null}
        </div>

        {blocking.length ? (
          <div className="simple-review-blocking" role="alert">
            <AlertTriangle aria-hidden="true" />
            <div><strong>Fix these before approving:</strong><ul>{blocking.map((text) => <li key={text}>{text}</li>)}</ul></div>
            <button type="button" aria-label="Dismiss" onClick={() => setBlocking([])}><X aria-hidden="true" /></button>
          </div>
        ) : null}

        <ReviewWorkspace
          initialSplit={40}
          hasSource={hasSource}
          sourceFileName={boq.sourceFileName || "source.pdf"}
          pdf={hasSource ? (
            <PdfReviewViewer
              sourceUrl={`/api/boqs/${encodeURIComponent(boq.id)}/source`}
              sourceFileName={boq.sourceFileName || "source.pdf"}
              resetKey={boq.id}
              requestedPage={focus.page}
              requestedPageKey={focus.key}
              evidenceFocus={evidenceFocus}
            />
          ) : null}
        >
          {quoteNotes.length ? (
            <ul className="simple-review-quote-notes">{quoteNotes.map((note) => <li key={note}><AlertTriangle aria-hidden="true" />{note}</li>)}</ul>
          ) : null}
          <table className="simple-review-table" aria-label="Quote rows">
            <thead>
              <tr>
                <th className="col-num">#</th>
                <th>Description</th>
                <th className="col-qty">Qty</th>
                <th className="col-unit">Unit</th>
                <th className="col-rate">Rate</th>
                <th className="col-total">Total</th>
                <th className="col-catalog">Catalog item</th>
              </tr>
            </thead>
            {sections.map((section, sectionIndex) => (
              <tbody key={`section-${sectionIndex}`}>
                {sections.length > 1 || section.header ? (
                  <tr className="simple-review-section"><th colSpan={7}>{section.header || `Section ${sectionIndex + 1}`}</th></tr>
                ) : null}
                {section.items.map((item, itemIndex) => {
                  const key = rowKey(sectionIndex, itemIndex)
                  const flags = rowFlags.get(key) ?? []
                  const rowNumber = rowNumbers.get(key) ?? 0
                  if (onlyFlagged && flags.length === 0) return null
                  if (!isPricedBoqItem(item)) {
                    return (
                      <tr key={key} className="simple-review-child" onClick={() => goToSource(key, item)}>
                        <td />
                        <td colSpan={6}>↳ {item.desc}</td>
                      </tr>
                    )
                  }
                  const pick = picks.get(key)
                  const standard = pick?.standardId ? standardsById.get(pick.standardId) : undefined
                  return (
                    <tr
                      key={key}
                      data-row={key}
                      className={`${flags.length ? "is-flagged" : ""} ${selectedKey === key ? "is-selected" : ""} ${item.optional ? "is-optional" : ""}`}
                      onClick={() => goToSource(key, item)}
                    >
                      <td className="col-num">{rowNumber}</td>
                      <td>
                        <textarea
                          aria-label={`Description row ${rowNumber}`}
                          className="simple-review-cell simple-review-desc"
                          rows={Math.min(3, Math.max(1, Math.ceil(item.desc.length / 60)))}
                          value={item.desc}
                          disabled={approved}
                          onFocus={() => goToSource(key, item)}
                          onChange={(e) => editItem(sectionIndex, itemIndex, (current) => ({ ...current, desc: e.target.value }))}
                        />
                        {item.optional ? <span className="simple-review-tag">Optional{item.excludedFromTotal ? " · not in total" : ""}</span> : null}
                        {flags.map((flag) => (
                          <span key={flag.text} className={`simple-review-flag flag-${flag.kind}`}><AlertTriangle aria-hidden="true" />{flag.text}</span>
                        ))}
                      </td>
                      <td><NumberCell label={`Qty row ${rowNumber}`} value={item.qty} disabled={approved} onFocus={() => goToSource(key, item)}
                        onCommit={(qty) => editItem(sectionIndex, itemIndex, (current) => ({ ...current, qty, total: round2(qty * current.rate) }))} /></td>
                      <td className="col-unit"><input aria-label={`Unit row ${rowNumber}`} className="simple-review-cell" value={item.unit} disabled={approved}
                        onFocus={() => goToSource(key, item)}
                        onChange={(e) => editItem(sectionIndex, itemIndex, (current) => ({ ...current, unit: e.target.value }))} /></td>
                      <td><NumberCell label={`Rate row ${rowNumber}`} value={item.rate} disabled={approved} onFocus={() => goToSource(key, item)}
                        onCommit={(rate) => editItem(sectionIndex, itemIndex, (current) => ({ ...current, rate, total: round2(current.qty * rate) }))} /></td>
                      <td><NumberCell label={`Total row ${rowNumber}`} value={item.total} disabled={approved} onFocus={() => goToSource(key, item)}
                        onCommit={(total) => editItem(sectionIndex, itemIndex, (current) => ({ ...current, total }))} /></td>
                      <td className="col-catalog" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className={`simple-review-pick ${pick?.standardId ? "" : "is-none"}`}
                          disabled={approved || !catalog}
                          aria-label={`Catalog item row ${rowNumber}`}
                          onClick={() => setPickerKey(pickerKey === key ? null : key)}
                        >
                          <span className="simple-review-pick-text">{standard ? standard.description : "No catalog item"}</span>
                          {standard && pick?.reason && pick.reason !== "Saved" ? <span className="simple-review-pick-reason">{pick.reason === "Exact" || pick.reason === "Alias" ? "match" : pick.reason === "Chosen" ? "chosen" : "best guess"}</span> : null}
                          <ChevronDown aria-hidden="true" />
                        </button>
                        {pickerKey === key && catalog ? (
                          <CatalogPicker
                            item={item}
                            standards={catalog.standards}
                            unitMap={catalog.unitMap}
                            selectedId={pick?.standardId ?? null}
                            onClose={() => setPickerKey(null)}
                            onPick={(standardId) => {
                              choosePick(key, standardId
                                ? { standardId, confidence: "manual", reason: "Chosen" }
                                : { standardId: null, reason: "Chosen" })
                              setPickerKey(null)
                            }}
                          />
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            ))}
          </table>

          {boq.activeExtractionRunId && !approved ? (
            <details className="simple-review-ai-rows">
              <summary>Possibly missed or mis-read rows (AI row check){missedCount ? ` · ${missedCount} to look at` : ""}</summary>
              <ExtractionReview
                boq={boq}
                canonicalRevisionKey={buildCanonicalRevisionKey(boq)}
                readOnly={approved}
                mutationBlockedReason={dirty ? "You have unapproved edits in the table. Approve them first, or reload to discard, before applying these fixes." : undefined}
                sourceAvailable={hasSource}
                onBoqChange={onBoqChange}
                onInboxCountChange={setMissedCount}
                onNavigateToEvidence={(target) => setFocus((current) => ({ page: target.page, table: target.table, row: target.row, key: current.key + 1 }))}
              />
            </details>
          ) : null}
        </ReviewWorkspace>
      </div>
    </div>
  )
}

function NumberCell({ label, value, disabled, onCommit, onFocus }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void; onFocus: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const invalid = text !== null && parseNumber(text) === null
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      inputMode="decimal"
      className={`simple-review-cell simple-review-number ${invalid ? "is-invalid" : ""}`}
      value={text ?? money(value)}
      disabled={disabled}
      onFocus={(e) => { setText(String(value)); onFocus(); e.currentTarget.select() }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const parsed = text === null ? null : parseNumber(text)
        if (parsed !== null && parsed !== value) onCommit(parsed)
        setText(null)
      }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setText(null); e.currentTarget.blur() } }}
    />
  )
}

function CatalogPicker({ item, standards, unitMap, selectedId, onPick, onClose }: {
  item: BoqPricedItem
  standards: StandardEntry[]
  unitMap: Record<string, string>
  selectedId: string | null
  onPick: (standardId: string | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const results = useMemo(() => searchCatalog(query, item, standards, unitMap), [item, query, standards, unitMap])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose() }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [onClose])
  return (
    <div className="simple-review-picker" ref={ref} role="dialog" aria-label="Choose catalog item">
      <label className="simple-review-picker-search">
        <Search aria-hidden="true" />
        <input autoFocus placeholder="Search catalog…" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onClose() }} />
      </label>
      <ul>
        <li><button type="button" className={selectedId === null ? "is-selected" : ""} onClick={() => onPick(null)}>No catalog item</button></li>
        {results.map((standard) => (
          <li key={standard.id}>
            <button type="button" className={selectedId === standard.id ? "is-selected" : ""} onClick={() => onPick(standard.id)}>
              <span>{standard.description}</span><span className="simple-review-muted">{standard.unit}</span>
            </button>
          </li>
        ))}
        {results.length === 0 ? <li className="simple-review-muted simple-review-picker-empty">No catalog items found.</li> : null}
      </ul>
    </div>
  )
}
