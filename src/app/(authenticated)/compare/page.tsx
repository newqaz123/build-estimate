"use client"

import { useEffect, useState, useMemo } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Check,
  ArrowLeftRight,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"
import type { Boq, BoqItem } from "@/lib/boq-schema"
import { ProtoDataTable } from "@/components/proto-data-table"

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

    const sourceIdentity = items
      .map((item) => `${item.boqId}:${item.id ?? item.code ?? ''}`)
      .toSorted()
      .join('|')
    rows.push({
      id: `row-${encodeURIComponent(sourceIdentity)}`,
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

export default function ComparePage() {
  const [boqs, setBoqs] = useState<Boq[]>([])
  const [loading, setLoading] = useState(true)
  const [baselineIdx, setBaselineIdx] = useState(0)
  const [expandedLlm, setExpandedLlm] = useState<string | null>(null)

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/boqs?limit=3")
        if (!res.ok) throw new Error("Failed to fetch")
        const data = await res.json()
        setBoqs(data.boqs || [])
      } catch {
        console.error("Failed to load BOQs")
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

  const [rows, setRows] = useState<MatchedRow[]>([])
  useEffect(() => {
    setRows(matchedRows)
  }, [matchedRows])

  const baselineName =
    boqs.length > 0
      ? boqs[baselineIdx]?.project + " (" + boqs[baselineIdx]?.vendor + ")"
      : "\u2014"

  const avgVariance = useMemo(() => {
    if (matchedRows.length === 0) return 0
    const totalVar = matchedRows.reduce((sum, row) => {
      const baselineItem = row.items[baselineIdx]
      if (!baselineItem || row.avgRate === 0) return sum
      return sum + Math.abs((baselineItem.rate - row.avgRate) / row.avgRate)
    }, 0)
    return (totalVar / matchedRows.length) * 100
  }, [matchedRows, baselineIdx])

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
          {[
            { label: 'BOQs Compared', value: boqs.length },
            { label: 'Items Matched', value: matchedRows.length },
            { label: 'Avg Variance', value: avgVariance > 0 ? `+${avgVariance.toFixed(1)}%` : `${avgVariance.toFixed(1)}%` },
          ].map(stat => (
            <div key={stat.label} className="proto-card stat-card">
              <div className="stat-value num">{stat.value}</div>
              <div className="stat-label">{stat.label}</div>
            </div>
          ))}
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
          Green = below avg &middot; Grey = at avg &middot; Red = above avg &middot; Amber = new item
        </span>
      </div>

      <ProtoDataTable
        headers={[
          { label: 'Description' },
          { label: 'Unit' },
          ...boqs.map(b => ({ label: `${b.project} — Rate`, className: 'num-col' })),
          { label: 'Avg Rate', className: 'num-col' },
          { label: 'Trend' },
          { label: 'Actions', className: 'text-right whitespace-nowrap' },
        ]}
      >
        {rows.map(row => {
          const expanded = expandedLlm === row.id
          const baselineItem = row.items[baselineIdx]
          const baselineRate = baselineItem?.rate
          const variancePct = baselineRate
            ? Math.abs(((row.avgRate - baselineRate) / baselineRate) * 100).toFixed(1)
            : null
          return (
            <tr key={row.id}>
              <td className="font-medium">{row.desc}</td>
              <td>{row.unit}</td>
              {row.items.map((item, i) => {
                const trend = item ? getTrend(item.rate, row.avgRate) : null
                const trendColor = trend === 'below' ? 'text-[#006400]' : trend === 'above' ? 'text-[#dc2626]' : ''
                return <td key={i} className={`num-col ${trendColor}`}>{item ? `฿${item.rate.toLocaleString()}` : '—'}</td>
              })}
              <td className="num-col">฿{row.avgRate.toLocaleString()}</td>
              <td>
                <span className={`inline-flex items-center gap-[5px] px-[10px] py-[2px] rounded-[9999px] text-xs font-medium cursor-pointer ${
                  row.trend === 'new' ? 'badge-suggested' : row.trend === 'below' ? 'badge-approved' : row.trend === 'above' ? 'badge-rejected' : 'badge-draft'
                }`}
                  onClick={() => setExpandedLlm(expandedLlm === row.id ? null : row.id)}
                >
                  {row.trend === 'below' && `↓ ${variancePct}% vs avg`}
                  {row.trend === 'at' && `→ at avg`}
                  {row.trend === 'above' && `↑ +${variancePct}% vs avg`}
                  {row.trend === 'new' && `★ New item`}
                </span>
                {expanded && (
                  <div className="llm-comment mt-2">
                    <div style={{fontFamily:'var(--font-mono)',fontSize:'11px',textTransform:'uppercase',letterSpacing:'0.05em',color:'var(--accent)',marginBottom:'4px'}}>LLM analysis · OpenAI GPT-4o</div>
                    {row.llm}
                  </div>
                )}
              </td>
              <td className="text-right whitespace-nowrap">
                {row.imported ? (
                  <span className="text-[11px] text-[#006400] font-medium inline-flex items-center gap-1">
                    <Check className="w-3 h-3" /> Imported
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setRows(prev => prev.map(r => r.id === row.id ? { ...r, imported: true } : r))
                      toast.success(`Imported "${row.desc}" to estimate`)
                    }}
                    className="btn btn-primary btn-xs"
                  >
                    Import
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </ProtoDataTable>
    </div>
  )
}
