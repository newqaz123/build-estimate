"use client"

import { useState, useCallback } from "react"
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
import { X, Eye, Check, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { Boq, BoqItem, WorkType } from "@/lib/boq-schema"

interface ReviewPanelProps {
  boq: Boq
  onClose: () => void
  onApproved: () => void
}

const VENDOR_SUGGESTIONS = [
  "Sino-Thai Engineering",
  "Italian-Thai Development",
  "Unique Engineering",
  "ITH Technology",
]
const PROJECT_SUGGESTIONS = [
  "Ratchaphruek Tower",
  "Sathorn Residences",
  "MRT Orange Line Station",
  "Bangna Warehouse Complex",
]

export function ReviewPanel({ boq, onClose, onApproved }: ReviewPanelProps) {
  const [items, setItems] = useState<BoqItem[]>(() => boq.sections.flatMap((s) => s.items))
  const [vendor, setVendor] = useState(boq.vendor)
  const [project, setProject] = useState(boq.project)
  const [workType, setWorkType] = useState<WorkType>(boq.workType)
  const [date, setDate] = useState(boq.date)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [approveLoading, setApproveLoading] = useState(false)
  const [llmVerified, setLlmVerified] = useState(false)

  const totalItems = items.length
  const grandTotal = items.reduce((s, i) => s + i.total, 0)

  const handleItemChange = useCallback(
    (idx: number, field: keyof BoqItem, value: string | number) => {
      setItems((prev) => {
        const updated = prev.map((item, i) => {
          if (i !== idx) return item
          const next = { ...item, [field]: value }
          if (field === "qty" || field === "rate") {
            next.total = next.qty * next.rate
          }
          return next
        })
        return updated
      })
    },
    []
  )

  const handleVerify = async () => {
    setVerifyLoading(true)
    try {
      const res = await fetch("/api/llm/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: `Verify these BOQ items are reasonable construction line items:\n${items
                .map((i) => `${i.code}: ${i.desc}, ${i.qty} ${i.unit} @ ${i.rate}`)
                .join("\n")}`,
            },
          ],
        }),
      })
      if (res.ok) {
        setLlmVerified(true)
        toast.success("LLM verification complete — all items look reasonable")
      } else {
        toast.error("Verification failed")
      }
    } catch {
      toast.error("Verification request failed")
    } finally {
      setVerifyLoading(false)
    }
  }

  const handleApprove = async () => {
    setApproveLoading(true)
    try {
      const res = await fetch(`/api/boqs/${boq.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          vendor,
          workType,
          date,
          status: "approved",
          sections: [{ header: "Parsed Items", items }],
        }),
      })
      if (!res.ok) throw new Error("Failed to update BOQ")
      toast.success("BOQ approved and saved")
      onApproved()
      onClose()
    } catch {
      toast.error("Failed to save BOQ")
    } finally {
      setApproveLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col" data-od-id="review-modal">
      <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <Eye className="w-5 h-5 text-accent" />
          <div>
            <span className="font-semibold text-sm">Review BOQ</span>
            <span className="text-xs text-muted-foreground ml-2">
              {project || "Untitled"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-[#666666]/12 text-[#666666]">
            Docling parsed
          </span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div
          className="flex-1 overflow-y-auto border-r border-border p-4"
          data-od-id="review-pdf-panel"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              Original BOQ PDF
            </span>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 max-w-[700px] mx-auto font-serif">
            <div className="mb-4">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-semibold tracking-wider uppercase text-gray-700">
                  Sino-Thai Engineering & Construction Co., Ltd.
                </span>
                <span className="text-[9px] text-gray-600">BOQ-001 Rev.A</span>
              </div>
              <div className="mt-1.5 text-[10px] text-gray-600">
                <div className="flex justify-between">
                  <span>Project: Ratchaphruek Tower</span>
                  <span>Date: 8 Jul 2026</span>
                </div>
                <div className="flex justify-between mt-0.5">
                  <span>Contract: Lump Sum</span>
                  <span>Page 1 of 3</span>
                </div>
              </div>
            </div>

            <table className="w-full text-[10px] border-collapse">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="text-left py-1 pr-2 font-semibold text-gray-700 w-[14%]">
                    Item Code
                  </th>
                  <th className="text-left py-1 pr-2 font-semibold text-gray-700 w-[36%]">
                    Description
                  </th>
                  <th className="text-left py-1 pr-2 font-semibold text-gray-700 w-[10%]">Unit</th>
                  <th className="text-right py-1 pr-2 font-semibold text-gray-700 w-[12%]">
                    Quantity
                  </th>
                  <th className="text-right py-1 pr-2 font-semibold text-gray-700 w-[14%]">
                    Unit Rate
                  </th>
                  <th className="text-right py-1 font-semibold text-gray-700 w-[14%]">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 7).map((item, idx) => (
                  <tr key={idx} className="border-b border-gray-100">
                    <td className="py-1 pr-2 text-gray-800">{item.code}</td>
                    <td className="py-1 pr-2 text-gray-800">{item.desc}</td>
                    <td className="py-1 pr-2 text-gray-800">{item.unit}</td>
                    <td className="py-1 pr-2 text-right text-gray-800">
                      {item.qty.toFixed(2)}
                    </td>
                    <td className="py-1 pr-2 text-right text-gray-800">
                      {item.rate.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-1 text-right text-gray-800">
                      {item.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-300">
                  <td
                    colSpan={5}
                    className="text-right py-1 pr-2 font-bold text-gray-800"
                  >
                    GRAND TOTAL
                  </td>
                  <td className="text-right py-1 font-bold text-gray-800">
                    {grandTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="mt-4 text-[9px] text-gray-500">
              <span>Notes: All rates in Thai Baht (THB). Prices exclude VAT.</span>
              <div className="flex justify-between mt-1">
                <span>Prepared by: S. Wongsuwan</span>
                <span>Approved by: P. Jetsadaporn</span>
              </div>
            </div>
          </div>
        </div>

        <div
          className="flex-1 overflow-y-auto p-4"
          data-od-id="review-data-panel"
        >
          <div className="mb-4">
            <h3 className="text-sm font-medium mb-3">BOQ Details</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Vendor</label>
                <Input
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  placeholder="e.g. Sino-Thai Engineering"
                  list="vendorSuggest"
                />
                <datalist id="vendorSuggest">
                  {VENDOR_SUGGESTIONS.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Project</label>
                <Input
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="e.g. Ratchaphruek Tower"
                  list="projectSuggest"
                />
                <datalist id="projectSuggest">
                  {PROJECT_SUGGESTIONS.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Work Type</label>
                <Select
                  value={workType}
                  onValueChange={(v) =>
                    setWorkType(v as WorkType)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Structural">Structural</SelectItem>
                    <SelectItem value="MEP">MEP</SelectItem>
                    <SelectItem value="Finishing">Finishing</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Document Date</label>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Parsed Items · {totalItems} line items
              </span>
              <span className="font-mono text-sm">
                Grand Total: ฿{grandTotal.toLocaleString()}
              </span>
            </div>
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-xs" data-od-id="review-items-table">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left p-2 font-medium">Code</th>
                    <th className="text-left p-2 font-medium">Description</th>
                    <th className="text-left p-2 font-medium">Unit</th>
                    <th className="text-right p-2 font-medium">Qty</th>
                    <th className="text-right p-2 font-medium">Rate (฿)</th>
                    <th className="text-right p-2 font-medium">Total</th>
                    <th className="text-left p-2 font-medium">Type</th>
                    <th className="text-left p-2 font-medium">Std</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-border last:border-b-0"
                      data-ri={idx}
                    >
                      <td className="p-1">
                        <Input
                          value={item.code}
                          onChange={(e) => handleItemChange(idx, "code", e.target.value)}
                          className="w-20 font-mono text-xs h-7"
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          value={item.desc}
                          onChange={(e) => handleItemChange(idx, "desc", e.target.value)}
                          className="w-full text-xs h-7"
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          value={item.unit}
                          onChange={(e) => handleItemChange(idx, "unit", e.target.value)}
                          className="w-16 text-xs h-7"
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          type="number"
                          value={item.qty}
                          onChange={(e) =>
                            handleItemChange(idx, "qty", parseFloat(e.target.value) || 0)
                          }
                          className="w-20 text-xs text-right h-7 font-mono"
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          type="number"
                          value={item.rate}
                          onChange={(e) =>
                            handleItemChange(idx, "rate", parseFloat(e.target.value) || 0)
                          }
                          className="w-20 text-xs text-right h-7 font-mono"
                        />
                      </td>
                      <td className="p-1 text-right font-mono text-xs">
                        ฿{item.total.toLocaleString()}
                      </td>
                      <td className="p-1">
                        <select
                          value={item.type}
                          onChange={(e) =>
                            handleItemChange(idx, "type", e.target.value)
                          }
                          className="h-7 text-xs rounded-md border border-input bg-transparent px-1.5 outline-none"
                        >
                          <option value="unit">Unit</option>
                          <option value="lump_sum">L/S</option>
                          <option value="job">Job</option>
                        </select>
                      </td>
                      <td className="p-1">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            item.stdStatus === "matched"
                              ? "bg-[#006400]/12 text-[#006400]"
                              : item.stdStatus === "pending"
                                ? "bg-accent/12 text-accent"
                                : "bg-[#dc2626]/12 text-[#dc2626]"
                          }`}
                        >
                          {item.stdStatus === "matched"
                            ? "Matched"
                            : item.stdStatus === "pending"
                              ? "Suggested"
                              : "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <StandardizationReview items={items} onItemsChange={setItems} />

          <div className="flex items-center justify-between pt-3 mt-3 border-t border-border">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Docling parsed <strong>{totalItems}</strong> line items
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleVerify}
              disabled={verifyLoading || llmVerified}
            >
              {verifyLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : llmVerified ? (
                <Check className="w-3 h-3" />
              ) : null}
              {llmVerified ? "Verified" : "Verify with LLM"}
            </Button>
          </div>

          <div className="flex justify-end gap-2 mt-4 pb-4">
            <Button variant="outline" size="sm" onClick={onClose}>
              Discard
            </Button>
            <Button size="sm" onClick={handleApprove} disabled={approveLoading}>
              {approveLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Approve & Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
