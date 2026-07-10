"use client"

import { useEffect, useState, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import {
  ChevronDown,
  ChevronUp,
  ArrowLeftRight,
  Plus,
  Check,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import type { Boq, BoqItem } from "@/lib/boq-schema"

interface ItemWithBoq extends BoqItem {
  boqId: string
  boqProject: string
  boqVendor: string
}

interface MatchedRow {
  id: string
  desc: string
  unit: string
  items: (ItemWithBoq | null)[]
  avgRate: number
  trend: "below" | "at" | "above" | "new"
  llm: string
  imported: boolean
}

const MOCK_LLM_COMMENTS: Record<string, string> = {
  concrete:
    "Rates within 3% of average across all BOQs. Qty variance is typical for this work type.",
  rebar:
    "Rebar pricing shows 5% spread. Higher rate correlates with smaller qty.",
  formwork:
    "Formwork rates are consistent (+-2%). Acceptable range for standard systems.",
  steel:
    "Steel frame pricing varies 8%. Verify grade and connection details.",
  default:
    "Item appears in multiple BOQs with rate variance within normal thresholds.",
  deck: "Metal deck rate below average by 6%. Verify gauge and coating match spec.",
  pile: "Bored pile rate 4% below average. Confirm depth and diameter match.",
  excavation:
    "Excavation rate competitive. Verify if disposal/fill included in all quotes.",
  waterproofing:
    "Waterproofing rates consistent. Confirm membrane type is comparable.",
  joint: "Expansion joint rates within range. Verify width and sealant spec.",
  mobilisation:
    "Site mobilisation LS item. Verify scope inclusions are comparable.",
}

function getTrend(rate: number, avg: number): "below" | "at" | "above" {
  const ratio = rate / avg
  if (ratio < 0.97) return "below"
  if (ratio > 1.03) return "above"
  return "at"
}

function generateLlmComment(desc: string): string {
  const lower = desc.toLowerCase()
  if (lower.includes("concrete")) return MOCK_LLM_COMMENTS.concrete
  if (lower.includes("rebar") || lower.includes("reinforcement"))
    return MOCK_LLM_COMMENTS.rebar
  if (lower.includes("formwork")) return MOCK_LLM_COMMENTS.formwork
  if (lower.includes("steel")) return MOCK_LLM_COMMENTS.steel
  if (lower.includes("deck")) return MOCK_LLM_COMMENTS.deck
  if (lower.includes("pile")) return MOCK_LLM_COMMENTS.pile
  if (lower.includes("excavation")) return MOCK_LLM_COMMENTS.excavation
  if (lower.includes("waterproof")) return MOCK_LLM_COMMENTS.waterproofing
  if (lower.includes("joint")) return MOCK_LLM_COMMENTS.joint
  if (lower.includes("mobilisation")) return MOCK_LLM_COMMENTS.mobilisation
  return MOCK_LLM_COMMENTS.default
}

function matchItems(boqs: Boq[]): MatchedRow[] {
  const boqList = boqs.slice(0, 3)

  const allItems: ItemWithBoq[] = boqList.flatMap((boq) =>
    boq.sections.flatMap((s) =>
      s.items.map((item) => ({
        ...item,
        boqId: boq.id,
        boqProject: boq.project,
        boqVendor: boq.vendor,
      }))
    )
  )

  const groups = new Map<string, ItemWithBoq[]>()
  for (const item of allItems) {
    const key = item.desc.toLowerCase().trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  const rows: MatchedRow[] = []
  for (const [, items] of groups) {
    const avgRate =
      items.reduce((s, i) => s + i.rate, 0) / items.length
    const trend = getTrend(items[0].rate, avgRate)
    const desc = items[0].desc
    const unit = items[0].unit

    const rowItems: (ItemWithBoq | null)[] = boqList.map((boq) => {
      const match = items.find((i) => i.boqId === boq.id) || null
      return match
    })

    rows.push({
      id: "row-" + desc.replace(/[^a-z0-9]/gi, "-").slice(0, 40),
      desc,
      unit,
      items: rowItems,
      avgRate,
      trend: items.length < boqList.length ? "new" : trend,
      llm: generateLlmComment(desc),
      imported: false,
    })
  }

  rows.sort((a, b) => {
    const aCount = a.items.filter(Boolean).length
    const bCount = b.items.filter(Boolean).length
    if (aCount !== bCount) return bCount - aCount
    return a.desc.localeCompare(b.desc)
  })

  return rows
}

function formatVariance(row: MatchedRow, baselineIdx: number): string {
  const baselineRate = row.items[baselineIdx]?.rate ?? row.avgRate
  const pct = ((baselineRate - row.avgRate) / row.avgRate * 100).toFixed(1)
  return pct + "% vs avg"
}

function trendBadgeClass(trend: string): string {
  if (trend === "below") return "bg-green-900/20 text-green-500"
  if (trend === "above") return "bg-red-900/20 text-red-500"
  if (trend === "new") return "bg-yellow-600/20 text-yellow-600"
  return "bg-gray-500/20 text-gray-400"
}

function trendIcon(trend: string): string {
  if (trend === "below") return "\u2193"
  if (trend === "above") return "\u2191"
  if (trend === "new") return "\u2605"
  return "\u2192"
}

function varianceBg(trend: string | null): string {
  if (trend === "below") return "bg-green-900/10"
  if (trend === "above") return "bg-red-900/10"
  if (trend === "at") return "bg-yellow-600/10"
  return ""
}

export default function ComparePage() {
  const [boqs, setBoqs] = useState<Boq[]>([])
  const [loading, setLoading] = useState(true)
  const [baselineIdx, setBaselineIdx] = useState(0)
  const [expandedLlm, setExpandedLlm] = useState<string | null>(null)
  const [importedRows, setImportedRows] = useState<Set<string>>(new Set())

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/boqs?limit=3")
        if (!res.ok) throw new Error("Failed to fetch")
        const data = await res.json()
        setBoqs(data.boqs || [])
      } catch {
        toast.error("Failed to load BOQs")
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const matchedRows = useMemo(() => {
    if (boqs.length === 0) return []
    return matchItems(boqs)
  }, [boqs])

  const baselineName =
    boqs.length > 0
      ? boqs[baselineIdx]?.project + " (" + boqs[baselineIdx]?.vendor + ")"
      : "\u2014"

  const itemsBelow = matchedRows.filter((r) => r.trend === "below").length
  const itemsAbove = matchedRows.filter((r) => r.trend === "above").length
  const itemsNew = matchedRows.filter((r) => r.trend === "new").length

  const avgVariance = useMemo(() => {
    if (matchedRows.length === 0) return 0
    const totalVar = matchedRows.reduce((sum, row) => {
      const baselineItem = row.items[baselineIdx]
      if (!baselineItem || row.avgRate === 0) return sum
      return sum + Math.abs((baselineItem.rate - row.avgRate) / row.avgRate)
    }, 0)
    return (totalVar / matchedRows.length) * 100
  }, [matchedRows, baselineIdx])

  function handleRowAction(rowId: string) {
    const next = new Set(importedRows)
    next.add(rowId)
    setImportedRows(next)
    const row = matchedRows.find((r) => r.id === rowId)
    console.log("Imported item:", {
      desc: row?.desc,
      unit: row?.unit,
      values: row?.items.map((i) =>
        i
          ? { qty: i.qty, rate: i.rate, total: i.total, boq: i.boqProject }
          : null
      ),
    })
    const label = row?.desc ?? "unknown"
    toast.success('"' + label + '" logged to console')
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center h-64 text-muted-foreground text-sm"
        data-od-id="compare-loading"
      >
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Loading BOQs...
      </div>
    )
  }

  if (boqs.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground"
        data-od-id="compare-empty"
      >
        <ArrowLeftRight className="w-10 h-10 opacity-40" />
        <p className="text-sm">
          No BOQs to compare. Upload at least one BOQ to get started.
        </p>
      </div>
    )
  }

  return (
    <div data-od-id="compare-page">
      <div className="mb-6" data-od-id="compare-summary">
        <div className="text-sm text-muted-foreground mb-4">
          Compare items across {boqs.length} vendor quotations. Baseline:{" "}
          <strong>{baselineName}</strong>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-5">
          <div
            className="rounded-xl border border-border bg-card p-5"
            data-od-id="summary-boqs"
          >
            <div className="font-mono text-[40px] font-semibold leading-none tracking-tight text-accent mb-1">
              {boqs.length}
            </div>
            <div className="text-sm text-muted-foreground">BOQs compared</div>
          </div>
          <div
            className="rounded-xl border border-border bg-card p-5"
            data-od-id="summary-matched"
          >
            <div className="font-mono text-[40px] font-semibold leading-none tracking-tight text-accent mb-1">
              {matchedRows.length}
            </div>
            <div className="text-sm text-muted-foreground">
              Items matched
              {itemsNew > 0 && (
                <span className="text-yellow-600 ml-1">
                  ({itemsNew} new)
                </span>
              )}
            </div>
          </div>
          <div
            className="rounded-xl border border-border bg-card p-5"
            data-od-id="summary-variance"
          >
            <div className="font-mono text-[40px] font-semibold leading-none tracking-tight mb-1">
              {avgVariance.toFixed(1)}%
            </div>
            <div className="text-sm text-muted-foreground">
              Avg variance from baseline
              {itemsBelow > 0 && (
                <span className="text-green-600 ml-2">
                  {itemsBelow} below
                </span>
              )}
              {itemsAbove > 0 && (
                <span className="text-red-600 ml-2">
                  {itemsAbove} above
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        className="flex items-center justify-between mb-4"
        data-od-id="compare-controls"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Baseline:</span>
          <Select
            value={String(baselineIdx)}
            onValueChange={(v) => setBaselineIdx(Number(v))}
          >
            <SelectTrigger className="w-[220px]" data-od-id="baseline-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {boqs.map((boq, i) => (
                <SelectItem key={boq.id} value={String(i)}>
                  {boq.project} ({boq.vendor})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground">
          Green = below avg &middot; Amber = at avg &middot; Red = above avg
        </span>
      </div>

      <div
        className="rounded-xl border border-border bg-card overflow-hidden"
        data-od-id="compare-table-wrap"
      >
        <div className="overflow-x-auto">
          <Table data-od-id="compare-table">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">Description</TableHead>
                <TableHead className="w-[60px]">Unit</TableHead>
                {boqs.map((boq, i) => (
                  <TableHead
                    key={boq.id}
                    colSpan={3}
                    className={
                      "text-center border-l border-border" +
                      (i === baselineIdx ? " bg-accent/5" : "")
                    }
                  >
                    <span className="text-xs font-semibold">
                      {boq.project}
                    </span>
                    <span className="block text-[10px] font-normal text-muted-foreground">
                      {boq.vendor}
                    </span>
                  </TableHead>
                ))}
                <TableHead className="w-[120px]">Analysis</TableHead>
                <TableHead className="w-[80px]">Action</TableHead>
              </TableRow>
              <TableRow>
                <TableHead />
                <TableHead />
                {boqs.map((boq, i) => (
                  <TableHead
                    key={"hdr-" + boq.id}
                    colSpan={3}
                    className={
                      "text-center border-l border-border text-[11px] font-normal text-muted-foreground" +
                      (i === baselineIdx ? " bg-accent/5" : "")
                    }
                  >
                    Qty &middot; Rate &middot; Total
                  </TableHead>
                ))}
                <TableHead />
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {matchedRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3 + boqs.length * 3 + 2}
                    className="text-center text-muted-foreground py-8"
                  >
                    No matched items found across these BOQs
                  </TableCell>
                </TableRow>
              ) : (
                matchedRows.map((row) => {
                  const isExpanded = expandedLlm === row.id
                  return (
                    <TableRow
                      key={row.id}
                      data-od-id={"compare-row-" + row.id}
                    >
                      <TableCell className="max-w-[200px]">
                        <div className="text-sm font-medium truncate">
                          {row.desc}
                        </div>
                        {row.imported && (
                          <Badge
                            variant="secondary"
                            className="mt-1 text-[10px] h-4 px-1.5"
                          >
                            <Check className="w-2.5 h-2.5 mr-0.5" />
                            Imported
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {row.unit}
                      </TableCell>
                      {boqs.map((boq, boqIdx) => {
                        const item = row.items[boqIdx]
                        const isBaseline = boqIdx === baselineIdx
                        const trend = item
                          ? getTrend(item.rate, row.avgRate)
                          : null
                        const bgClass = varianceBg(trend)

                        return (
                          <TableCell
                            key={"val-" + boq.id}
                            colSpan={3}
                            className={
                              "border-l border-border p-0" +
                              (isBaseline
                                ? " ring-1 ring-accent/20 ring-inset"
                                : "")
                            }
                          >
                            {item ? (
                              <div
                                className={
                                  "grid grid-cols-3 gap-0" +
                                  (bgClass ? " " + bgClass : "")
                                }
                              >
                                <div className="text-right font-mono text-sm px-2 py-2">
                                  {item.qty.toLocaleString()}
                                </div>
                                <div className="text-right font-mono text-sm px-2 py-2 border-l border-border/50">
                                  {"\u0E3F" + item.rate.toLocaleString()}
                                </div>
                                <div className="text-right font-mono text-sm font-semibold px-2 py-2 border-l border-border/50">
                                  {"\u0E3F" + item.total.toLocaleString()}
                                </div>
                              </div>
                            ) : (
                              <div className="text-center text-muted-foreground text-xs py-2">
                                {"\u2014"}
                              </div>
                            )}
                          </TableCell>
                        )
                      })}
                      <TableCell className="min-w-[140px]">
                        <button
                          className={
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer transition-colors border-none " +
                            trendBadgeClass(row.trend)
                          }
                          onClick={() =>
                            setExpandedLlm(
                              isExpanded ? null : row.id
                            )
                          }
                          data-od-id={"llm-badge-" + row.id}
                        >
                          {trendIcon(row.trend)}{" "}
                          {row.trend === "new"
                            ? "New item"
                            : formatVariance(row, baselineIdx)}
                          {isExpanded ? (
                            <ChevronUp className="w-3 h-3" />
                          ) : (
                            <ChevronDown className="w-3 h-3" />
                          )}
                        </button>
                        {isExpanded && (
                          <div className="mt-2 text-xs text-muted-foreground leading-relaxed bg-muted/30 rounded-lg p-2">
                            <div className="text-[10px] text-muted-foreground font-medium mb-1 uppercase tracking-wider">
                              LLM Analysis
                            </div>
                            {row.llm}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant={row.imported ? "ghost" : "outline"}
                          size="xs"
                          disabled={row.imported}
                          onClick={() => handleRowAction(row.id)}
                          data-od-id={"action-btn-" + row.id}
                          className="whitespace-nowrap"
                        >
                          {row.imported ? (
                            <>
                              <Check className="w-3 h-3 mr-1" />
                              Done
                            </>
                          ) : (
                            <>
                              <Plus className="w-3 h-3 mr-1" />
                              Import
                            </>
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
