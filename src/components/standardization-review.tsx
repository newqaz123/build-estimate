"use client"

import { useId, useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { ChevronRight, ChevronDown } from "lucide-react"
import { toast } from "sonner"
import type { BoqItem } from "@/lib/boq-schema"
import type { StandardEntry } from "@/lib/standard-schema"

interface StandardizationReviewProps {
  items: BoqItem[]
  onItemsChange: (items: BoqItem[]) => void
}

function normalizeDesc(desc: string): string {
  return desc.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^\w\s\/\-\dx]/g, "")
}

export function StandardizationReview({ items, onItemsChange }: StandardizationReviewProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const [standards, setStandards] = useState<StandardEntry[]>([])
  const [llmRunning, setLlmRunning] = useState(false)
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
        if (item.stdStatus === "matched") return item

        const itemDesc = normalizeDesc(item.desc)
        const itemUnit = item.unit?.toLowerCase() || ""

        const exact = standards.find(
          (s) => normalizeDesc(s.description) === itemDesc && s.unit.toLowerCase() === itemUnit
        )
        if (exact) {
          return { ...item, stdStatus: "matched" as const, stdMatch: exact.description }
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

  const acceptAll = () => {
    let count = 0
    const updated = items.map((item) => {
      if (item.stdStatus === "pending") {
        count++
        return { ...item, stdStatus: "matched" as const }
      }
      return item
    })
    onItemsChange(updated)
    if (count > 0) toast.success(`Accepted ${count} suggestions`)
    else toast.info("No pending suggestions")
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
      const catalog = standards.map((s) => `${s.description} (${s.unit})`).join("\n")
      const prompt = `Standard catalog:\n${catalog}\n\nMatch these items:\n${unmatchedItems
        .map(({ item }, idx) => `${idx + 1}. "${item.desc}" unit: ${item.unit}`)
        .join("\n")}\n\nReturn JSON array: [{index: number, stdDescription: string}]`

      const res = await fetch("/api/llm/standardize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: controller.signal,
      })

      if (!mountedRef.current || controller.signal.aborted || llmControllerRef.current !== controller) return
      if (!res.ok) throw new Error("LLM call failed")
      const result = await res.json()
      if (!mountedRef.current || controller.signal.aborted || llmControllerRef.current !== controller) return
      const text = result.content || result.text || "[]"
      let suggestions: { index: number; stdDescription: string }[]
      try {
        suggestions = JSON.parse(text)
      } catch {
        suggestions = []
      }

      if (!Array.isArray(suggestions)) {
        if (!mountedRef.current || llmControllerRef.current !== controller) return
        toast.error("LLM returned unexpected format")
        return
      }

      const updated = [...itemsRef.current]
      suggestions.forEach((s) => {
        const unmatched = unmatchedItems[s.index - 1]
        if (unmatched && updated[unmatched.originalIndex]) {
          const idx = unmatched.originalIndex
          const st = standards.find((st) => st.description === s.stdDescription)
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
          {matched} matched · {pending} suggested · {unmatched} need review
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
            {items.map((item, idx) => (
              <div
                key={item.id ?? `${normalizeDesc(item.desc)}-${item.unit}-${idx}`}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 text-xs"
              >
                {showStdBadge(item)}
                <span className="flex-1 truncate">{item.desc}</span>
                <span className="text-muted-foreground">{item.unit}</span>
                {item.stdMatch && item.stdMatch !== item.desc && (
                  <span className="text-accent truncate">→ {item.stdMatch}</span>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={acceptAll} disabled={pending === 0}>
              Accept All Suggested
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
