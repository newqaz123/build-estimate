"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Plus,
  Trash2,
  Send,
  MessageSquare,
  X,
  Loader2,
  Check,
  Lightbulb,
  FileDown,
} from "lucide-react"
import { toast } from "sonner"
import type { Estimate, EstimateItem } from "@/lib/estimate-schema"

interface EstimateItemLocal {
  id: string
  code: string
  desc: string
  unit: string
  qty: number
  rate: number
  total: number
  source: "imported" | "manual" | "adjustment"
}

interface ChatMessage {
  role: "user" | "bot"
  text: string
  suggestions?: {
    desc: string
    unit: string
    rate: number
    qty: number
  }[]
}

const SUGGESTIONS_MAP: Record<string, ChatMessage["suggestions"]> = {
  concrete: [
    { desc: "Structural concrete C32/40", unit: "m³", rate: 3850, qty: 50 },
    { desc: "Structural concrete C25/30", unit: "m³", rate: 3450, qty: 80 },
    { desc: "Reinforcement bar SD40 — 16mm", unit: "ton", rate: 28500, qty: 12 },
    { desc: "Reinforcement bar SD40 — 12mm", unit: "ton", rate: 29000, qty: 8 },
    { desc: "Formwork — column", unit: "m²", rate: 680, qty: 300 },
    { desc: "Formwork — slab", unit: "m²", rate: 590, qty: 500 },
  ],
  steel: [
    { desc: "Steel frame — main beams", unit: "ton", rate: 42000, qty: 25 },
    { desc: "Metal deck flooring", unit: "m²", rate: 950, qty: 400 },
    { desc: "Bored pile — D0.80m x 18m", unit: "m", rate: 4500, qty: 16 },
  ],
  mep: [
    { desc: "HVAC ductwork — supply", unit: "m²", rate: 1850, qty: 150 },
    { desc: "Electrical cable tray — 300mm", unit: "m", rate: 850, qty: 80 },
    { desc: "Plumbing — PVC pipe 4\"", unit: "m", rate: 280, qty: 120 },
    { desc: "Fire suppression — sprinkler head", unit: "ea", rate: 450, qty: 30 },
  ],
  finishing: [
    { desc: "Ceramic tile — floor 600×600", unit: "m²", rate: 680, qty: 350 },
    { desc: "Suspended ceiling — T-grid system", unit: "m²", rate: 520, qty: 300 },
    { desc: "Paint — interior emulsion", unit: "m²", rate: 85, qty: 800 },
    { desc: "Door — hollow core 0.9m", unit: "ea", rate: 4500, qty: 15 },
  ],
}

function getSuggestions(input: string): ChatMessage["suggestions"] {
  const t = input.toLowerCase()
  const result: ChatMessage["suggestions"] = []
  if (/concrete|column|slab|beam|foundation|rc/i.test(t))
    result.push(...(SUGGESTIONS_MAP.concrete ?? []))
  if (/steel|metal|frame|deck/i.test(t))
    result.push(...(SUGGESTIONS_MAP.steel ?? []))
  if (/hvac|ac|air|electrical|cable|plumbing|pipe|fire|sprinkler|mep/i.test(t))
    result.push(...(SUGGESTIONS_MAP.mep ?? []))
  if (/finish|tile|paint|ceiling|floor|wall|interior|door/i.test(t))
    result.push(...(SUGGESTIONS_MAP.finishing ?? []))
  if (result.length === 0) {
    result.push(
      { desc: "Concrete C32/40 — columns", unit: "m³", rate: 3850, qty: 30 },
      { desc: "Rebar SD40 — 16mm", unit: "ton", rate: 28500, qty: 8 },
      { desc: "Formwork — slab", unit: "m²", rate: 590, qty: 400 },
      { desc: "Ceramic tile — floor 600×600", unit: "m²", rate: 680, qty: 200 }
    )
  }
  return result.slice(0, 6)
}

export default function EstimatorPage() {
  const [projectName, setProjectName] = useState("New Estimate")
  const [projectDate, setProjectDate] = useState(
    new Date().toISOString().split("T")[0]
  )
  const [projectDesc, setProjectDesc] = useState("")
  const [items, setItems] = useState<EstimateItemLocal[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([])
  const [chatWaiting, setChatWaiting] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function fetchEstimates() {
      try {
        const res = await fetch("/api/estimates")
        if (res.ok) {
          const data = await res.json()
          if (data.estimates && data.estimates.length > 0) {
            const last = data.estimates[0] as Estimate
            setProjectName(last.name || "New Estimate")
            setProjectDate(last.date || "")
            setProjectDesc(last.notes || "")
          }
        }
      } catch {
      } finally {
        setLoading(false)
      }
    }
    fetchEstimates()
  }, [])

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [chatMsgs])

  function addItem(item?: Partial<EstimateItemLocal>) {
    const newItem: EstimateItemLocal = {
      id: `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      code: item?.code || "",
      desc: item?.desc || "",
      unit: item?.unit || "",
      qty: item?.qty ?? 1,
      rate: item?.rate ?? 0,
      total: (item?.qty ?? 1) * (item?.rate ?? 0),
      source: item?.source || "manual",
    }
    setItems((prev) => [...prev, newItem])
  }

  function updateItem(
    id: string,
    field: "qty" | "rate" | "desc" | "code" | "unit",
    value: string | number
  ) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        const updated = { ...item, [field]: value }
        if (field === "qty" || field === "rate") {
          const q = field === "qty" ? Number(value) : item.qty
          const r = field === "rate" ? Number(value) : item.rate
          updated.total = (q || 0) * (r || 0)
        }
        return updated
      })
    )
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  const totalAmount = items.reduce((sum, i) => sum + i.total, 0)

  async function handleSave() {
    if (items.length === 0) {
      toast.error("Add at least one item")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/estimates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: projectName || "New Estimate",
          project: projectName,
          date: projectDate,
          notes: projectDesc,
          items: items.map((i) => ({
            code: i.code,
            desc: i.desc,
            unit: i.unit,
            qty: i.qty,
            rate: i.rate,
            total: i.total,
            source: i.source,
          })),
        }),
      })
      if (!res.ok) throw new Error("Save failed")
      toast.success("Estimate saved")
    } catch {
      toast.error("Failed to save estimate")
    } finally {
      setSaving(false)
    }
  }

  function openChat() {
    setChatOpen(true)
    if (chatMsgs.length === 0) {
      setChatMsgs([
        {
          role: "bot",
          text: "Hi! I'm your BOQ Assistant. Tell me about your project — what kind of building or structure?",
        },
      ])
    }
  }

  function sendChatMsg() {
    const text = chatInput.trim()
    if (!text || chatWaiting) return
    setChatInput("")
    setChatMsgs((prev) => [...prev, { role: "user", text }])
    setChatWaiting(true)
    setTimeout(() => {
      const suggestions = getSuggestions(text) || []
      const total = suggestions.reduce(
        (s, i) => s + i.qty * i.rate,
        0
      )
      setChatMsgs((prev) => [
        ...prev,
        {
          role: "bot",
          text: `Based on your description, here are suggested items (quantities are estimates):`,
          suggestions,
        },
      ])
      setChatWaiting(false)
    }, 800)
  }

  type SuggestionItem = NonNullable<ChatMessage["suggestions"]>[number]

  function chatAddSuggestion(s: SuggestionItem) {
    addItem({
      desc: s.desc,
      unit: s.unit,
      rate: s.rate,
      qty: s.qty,
      source: "manual",
    })
    toast.success(`Added "${s.desc}"`)
  }

  function chatAddAll() {
    const lastMsg = chatMsgs[chatMsgs.length - 1]
    if (!lastMsg?.suggestions) return
    let count = 0
    for (const s of lastMsg.suggestions) {
      addItem({
        desc: s.desc,
        unit: s.unit,
        rate: s.rate,
        qty: s.qty,
        source: "manual",
      })
      count++
    }
    toast.success(`Added ${count} items`)
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center h-64 text-muted-foreground text-sm"
        data-od-id="estimator-loading"
      >
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Loading...
      </div>
    )
  }

  return (
    <div className="relative min-h-[calc(100vh-8rem)]" data-od-id="estimator-page">
      <div className="pb-20">
        <div className="flex flex-wrap gap-4 items-start mb-4" data-od-id="project-meta">
          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Project Name
            </label>
            <Input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name…"
              data-od-id="project-name"
              className="text-base font-semibold h-9"
            />
          </div>
          <div className="flex flex-col gap-1 w-[160px]">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Date of Estimate
            </label>
            <Input
              type="date"
              value={projectDate}
              onChange={(e) => setProjectDate(e.target.value)}
              data-od-id="project-date"
              className="h-9"
            />
          </div>
        </div>
        <div className="mb-4">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Description
            </label>
            <textarea
              value={projectDesc}
              onChange={(e) => setProjectDesc(e.target.value)}
              placeholder="Project description, location, notes…"
              rows={2}
              data-od-id="project-desc"
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 resize-y min-h-[32px] leading-relaxed"
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between mb-3"
          data-od-id="est-header"
        >
          <h2 className="text-base font-semibold">
            Estimate Items
            {items.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground ml-2">
                ({items.length} items)
              </span>
            )}
          </h2>
          <Button
            size="sm"
            onClick={() => addItem()}
            data-od-id="add-item-btn"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Item
          </Button>
        </div>

        <div
          className="rounded-xl border border-border bg-card overflow-hidden"
          data-od-id="est-list"
        >
          {items.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-16 text-center"
              data-od-id="est-empty"
            >
              <Lightbulb className="w-8 h-8 text-muted-foreground/40 mb-3" />
              <h3 className="text-sm font-medium mb-1">No items added</h3>
              <p className="text-xs text-muted-foreground mb-4">
                Click <strong>+ Add Item</strong> to add manually, or use the
                chat bubble to generate items with AI.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={openChat}
                data-od-id="open-chat-empty"
              >
                <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                Open AI Assistant
              </Button>
            </div>
          ) : (
            <div>
              {items.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-[60px_1fr_56px_60px_100px_100px_28px] gap-1.5 items-center px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/5 transition-colors"
                  data-od-id={`est-row-${item.id}`}
                >
                  <Input
                    type="text"
                    value={item.code || ""}
                    onChange={(e) =>
                      updateItem(item.id, "code", e.target.value)
                    }
                    className="h-7 w-16 text-xs font-mono"
                    placeholder="code"
                    data-od-id={`edit-code-${item.id}`}
                  />
                  <Input
                    type="text"
                    value={item.desc || ""}
                    onChange={(e) =>
                      updateItem(item.id, "desc", e.target.value)
                    }
                    className="h-7 text-xs flex-1"
                    placeholder="Item description"
                    data-od-id={`edit-desc-${item.id}`}
                  />
                  <Input
                    type="text"
                    value={item.unit || ""}
                    onChange={(e) =>
                      updateItem(item.id, "unit", e.target.value)
                    }
                    className="h-7 w-16 text-xs"
                    placeholder="unit"
                    data-od-id={`edit-unit-${item.id}`}
                  />
                  <Input
                    type="number"
                    value={item.qty}
                    onChange={(e) =>
                      updateItem(item.id, "qty", e.target.value)
                    }
                    className="h-7 text-xs font-mono text-right"
                    min="0"
                    step="0.5"
                    data-od-id={`edit-qty-${item.id}`}
                  />
                  <div className="flex items-center justify-end">
                    <span className="text-xs font-mono text-muted-foreground mr-1">
                      ฿
                    </span>
                    <Input
                      type="number"
                      value={item.rate}
                      onChange={(e) =>
                        updateItem(item.id, "rate", e.target.value)
                      }
                      className="h-7 text-xs font-mono text-right"
                      min="0"
                      step="100"
                      data-od-id={`edit-rate-${item.id}`}
                    />
                  </div>
                  <div className="text-right font-mono text-sm font-semibold">
                    ฿{item.total.toLocaleString()}
                  </div>
                  <div className="text-center">
                    <button
                      onClick={() => removeItem(item.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer border-none bg-transparent p-1"
                      data-od-id={`delete-item-${item.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {items.length > 0 && (
        <div
          className="fixed bottom-0 left-[var(--sidebar-w,260px)] right-0 flex items-center justify-between px-5 py-3 bg-card border-t border-border z-10"
          data-od-id="est-summary"
        >
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Estimated Total
            </div>
            <div className="font-mono text-xl font-bold">
              ฿{totalAmount.toLocaleString()}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setItems([])
                toast.info("Estimate cleared")
              }}
              data-od-id="clear-estimate"
            >
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.print()}
              data-od-id="export-pdf"
            >
              <FileDown className="w-3.5 h-3.5" />
              PDF
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || items.length === 0}
              data-od-id="save-estimate"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4 mr-1.5" />
                  Save Estimate
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <button
        className={`fixed bottom-20 right-6 w-12 h-12 rounded-full bg-accent text-white border-none cursor-pointer flex items-center justify-center shadow-lg z-20 transition-transform hover:scale-105 ${
          chatOpen ? "scale-0 opacity-0" : ""
        }`}
        onClick={openChat}
        data-od-id="chat-bubble"
      >
        <MessageSquare className="w-5 h-5" />
      </button>

      {chatOpen && (
        <div
          className="fixed bottom-20 right-6 w-[380px] h-[520px] bg-card rounded-2xl shadow-2xl z-20 flex flex-col overflow-hidden border border-border max-sm:w-[calc(100vw-2rem)] max-sm:h-[60vh]"
          data-od-id="chat-panel"
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
            <MessageSquare className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold flex-1">
              BOQ Assistant
            </span>
            <button
              onClick={() => setChatOpen(false)}
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer border-none bg-transparent p-1"
              data-od-id="chat-close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {chatMsgs.map((msg, i) => (
              <div key={i}>
                <div
                  className={`max-w-[90%] px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-accent text-accent-foreground ml-auto rounded-br-sm"
                      : "bg-muted/50 border border-border rounded-bl-sm"
                  }`}
                >
                  {msg.role === "bot" && (
                    <div className="text-[11px] font-semibold text-accent mb-1">
                      BOQ Assistant
                    </div>
                  )}
                  <div
                    dangerouslySetInnerHTML={{
                      __html: msg.text.replace(/\n/g, "<br/>"),
                    }}
                  />
                </div>
                {msg.suggestions && msg.suggestions.length > 0 && (
                  <div className="mt-2 ml-2 space-y-2">
                    {msg.suggestions.map((s, si) => (
                      <div
                        key={si}
                        className="bg-card border border-border rounded-lg p-2.5"
                      >
                        <div className="text-sm font-medium">{s.desc}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {s.qty} {s.unit} × ฿
                          {s.rate.toLocaleString()} = ฿
                          {(s.qty * s.rate).toLocaleString()}
                        </div>
                        <Button
                          variant="default"
                          size="xs"
                          className="mt-1.5"
                          onClick={() => chatAddSuggestion(s)}
                          data-od-id={`chat-add-${si}`}
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={chatAddAll}
                      data-od-id="chat-add-all"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add All to Estimate
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {chatWaiting && (
              <div className="bg-muted/50 border border-border rounded-2xl rounded-bl-sm px-3 py-2 max-w-[60%]">
                <div className="flex gap-1.5 items-center py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" />
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0.2s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0.4s]" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="flex items-center gap-2 px-3 py-2.5 border-t border-border bg-muted/30">
            <Input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendChatMsg()
              }}
              placeholder="Describe your work…"
              className="h-8 text-sm"
              data-od-id="chat-input"
            />
            <Button
              size="icon-sm"
              onClick={sendChatMsg}
              disabled={chatWaiting || !chatInput.trim()}
              data-od-id="chat-send"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
