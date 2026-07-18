"use client"

import { useId, useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { BoqItem } from "@/lib/boq-schema"
import type { StandardEntry } from "@/lib/standard-schema"

interface StandardizationReviewProps {
  items: BoqItem[]
  onItemsChange: (items: BoqItem[]) => void
  onMatchRequest?: (item: BoqItem, index: number) => void
  onExcludeRequest?: (item: BoqItem, index: number, reason: string) => Promise<boolean>
  catalogBusyIndex?: number | null
}

function normalizeDesc(desc: string): string {
  return desc.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^\w\s\/\-\dx]/g, "")
}

export function StandardizationReview({ items, onItemsChange, onMatchRequest, onExcludeRequest, catalogBusyIndex }: StandardizationReviewProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const [standards, setStandards] = useState<StandardEntry[]>([])
  const [llmRunning, setLlmRunning] = useState(false)
  const [excludeIndex, setExcludeIndex] = useState<number | null>(null)
  const [excludeReason, setExcludeReason] = useState("")
  const ranRef = useRef(false)
  const itemsRef = useRef(items)
  const mountedRef = useRef(true)
  const llmControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      llmControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    fetch("/api/standards")
      .then((r) => r.json())
      .then(setStandards)
      .catch(() => {})
  }, [])

  const runStandardization = useCallback(
    (currentItems: BoqItem[]): BoqItem[] => {
      return currentItems.map((item) => {
        if (item.stdStatus === "matched" || item.stdStatus === "excluded") return item

        const itemDesc = normalizeDesc(item.desc)
        const itemUnit = item.unit?.toLowerCase() || ""

        const exact = standards.find(
          (s) => normalizeDesc(s.description) === itemDesc && s.unit.toLowerCase() === itemUnit
        )
        if (exact) {
          return { ...item, stdStatus: "pending" as const, stdMatch: exact.description }
        }

        const alias = standards.find((s) =>
          s.aliases.some((a) => normalizeDesc(a) === itemDesc && s.unit.toLowerCase() === itemUnit)
        )
        if (alias) {
          return { ...item, stdStatus: "pending" as const, stdMatch: alias.description }
        }

        return { ...item, stdStatus: "unmatched" as const, stdMatch: undefined }
      })
    },
    [standards]
  )

  useEffect(() => {
    if (standards.length > 0 && !ranRef.current) {
      ranRef.current = true
      const updated = runStandardization(items)
      onItemsChange(updated)
    }
  }, [standards, items, runStandardization, onItemsChange])

  const matched = items.filter((i) => i.stdStatus === "matched").length
  const pending = items.filter((i) => i.stdStatus === "pending").length
  const unmatched = items.filter((i) => i.stdStatus === "unmatched" || !i.stdStatus).length
  const excluded = items.filter((i) => i.stdStatus === "excluded").length

  const acceptAll = () => {
    toast.info("Open the saved BOQ and confirm each catalog link before it is marked as matched")
  }

  const runLLM = async () => {
    const unmatchedItems = items
      .map((item, originalIndex) => ({ item, originalIndex }))
      .filter(({ item }) => item.stdStatus === "unmatched")
    if (unmatchedItems.length === 0) {
      toast.info("No unmatched items")
      return
    }
    llmControllerRef.current?.abort()
    const controller = new AbortController()
    llmControllerRef.current = controller
    setLlmRunning(true)
    try {
      const res = await fetch("/api/llm/standardize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: unmatchedItems.map(({ item, originalIndex }) => ({
          key: String(originalIndex), description: item.desc, unit: item.unit,
        })) }),
        signal: controller.signal,
      })

      if (!mountedRef.current || controller.signal.aborted || llmControllerRef.current !== controller) return
      if (!res.ok) throw new Error("LLM call failed")
      const result = await res.json() as { suggestions?: Array<{ key: string; standardId: string; description: string }> }
      if (!mountedRef.current || controller.signal.aborted || llmControllerRef.current !== controller) return
      const suggestions = result.suggestions
      if (!Array.isArray(suggestions)) {
        if (!mountedRef.current || llmControllerRef.current !== controller) return
        toast.error("LLM returned unexpected format")
        return
      }

      const updated = [...itemsRef.current]
      suggestions.forEach((s) => {
        const idx = Number(s.key)
        if (Number.isInteger(idx) && updated[idx]) {
          const st = standards.find((standard) => standard.id === s.standardId)
          if (st) {
            updated[idx] = { ...updated[idx], stdStatus: "pending" as const, stdMatch: st.description }
          }
        }
      })

      if (!mountedRef.current || controller.signal.aborted || llmControllerRef.current !== controller) return
      onItemsChange(updated)
      toast.success("LLM suggestions applied")
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return
      if (!mountedRef.current || llmControllerRef.current !== controller) return
      toast.error("LLM standardization failed")
    } finally {
      if (mountedRef.current && llmControllerRef.current === controller) {
        llmControllerRef.current = null
        setLlmRunning(false)
      }
    }
  }

  const showStdBadge = (item: BoqItem) => {
    if (item.stdStatus === "matched")
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#006400]/12 text-[#006400]">
          Matched
        </span>
      )
    if (item.stdStatus === "pending")
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/12 text-accent">
          Suggested
        </span>
      )
    if (item.stdStatus === "excluded")
      return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
          Excluded
        </span>
      )
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#dc2626]/12 text-[#dc2626]">
        Unmatched
      </span>
    )
  }

  return (
    <div data-od-id="standardization-review" className="border-t border-border pt-3 mt-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full mb-2 text-left"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="text-sm font-medium flex items-center gap-1.5">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Standardization
        </span>
        <span className="text-xs text-muted-foreground">
          {matched} matched · {excluded} excluded · {pending + unmatched} need review
        </span>
      </button>

      <div className="flex gap-1.5 text-xs mb-2">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#006400]/12 text-[#006400] text-[10px] font-medium">
          {matched} matched
        </span>
        {pending > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/12 text-accent text-[10px] font-medium">
            {pending} suggested
          </span>
        )}
        {unmatched > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#eab308]/18 text-[#b88a00] text-[10px] font-medium">
            {unmatched} unmatched
          </span>
        )}
      </div>

      {open && (
        <div id={panelId}>
          <div className="space-y-1.5 max-h-[300px] overflow-y-auto mb-3">
            {items.map((item, idx) => {
              const needsResolution = item.rate > 0 && item.stdStatus !== "matched" && item.stdStatus !== "excluded"
              const busy = catalogBusyIndex === idx
              return (
                <div key={item.id ?? `${normalizeDesc(item.desc)}-${item.unit}-${idx}`} className="rounded-lg bg-muted/30 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    {showStdBadge(item)}
                    <span className="min-w-0 flex-1 truncate">{item.desc}</span>
                    <span className="text-muted-foreground">{item.unit}</span>
                    {item.stdMatch && item.stdMatch !== item.desc ? <span className="max-w-36 truncate text-accent">→ {item.stdMatch}</span> : null}
                    {needsResolution && onMatchRequest && onExcludeRequest ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <Button type="button" size="sm" variant="outline" onClick={() => onMatchRequest(item, idx)} disabled={busy}>Match or create</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => { setExcludeIndex(idx); setExcludeReason("") }} disabled={busy}>Exclude</Button>
                      </span>
                    ) : null}
                  </div>
                  {excludeIndex === idx && onExcludeRequest ? (
                    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
                      <Input value={excludeReason} onChange={(event) => setExcludeReason(event.target.value)} placeholder="Reason this line should not use catalog pricing" aria-label={`Exclusion reason for ${item.desc}`} className="h-8" autoFocus />
                      <Button type="button" size="sm" onClick={async () => { if (await onExcludeRequest(item, idx, excludeReason)) { setExcludeIndex(null); setExcludeReason("") } }} disabled={busy || !excludeReason.trim()}>
                        {busy ? <Loader2 className="animate-spin" /> : null} Confirm
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setExcludeIndex(null)} disabled={busy}>Cancel</Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={acceptAll} disabled={pending === 0}>
              Review matches after save
            </Button>
            <Button size="sm" variant="outline" onClick={runLLM} disabled={llmRunning || unmatched === 0}>
              {llmRunning ? "Running..." : "Run LLM on Unmatched"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
