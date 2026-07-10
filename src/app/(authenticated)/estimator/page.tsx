"use client"

import { useEffect, useState, useRef, useCallback } from "react"
import { toast } from "sonner"
import type { Estimate } from "@/lib/estimate-schema"

interface EstimateItemLocal {
  id: string
  desc: string
  qty: number
  rate: number
  unit: string
  total: number
  source: "imported" | "manual" | "adjustment"
}

interface ChatMessage {
  role: "user" | "bot"
  text: string
  choices?: string[]
  suggestions?: {
    desc: string
    unit: string
    rate: number
    qty: number
  }[]
}

const HISTORICAL_ITEMS = [
  { id: 'h1', desc: 'Structural concrete C32/40', avgRate: 3850, unit: 'm³', category: 'Structural', source: '3 BOQs' },
  { id: 'h2', desc: 'Structural concrete C25/30', avgRate: 3450, unit: 'm³', category: 'Structural', source: '4 BOQs' },
  { id: 'h3', desc: 'Reinforcement bar SD40 — 16mm', avgRate: 28500, unit: 'ton', category: 'Structural', source: '3 BOQs' },
  { id: 'h4', desc: 'Reinforcement bar SD40 — 12mm', avgRate: 29000, unit: 'ton', category: 'Structural', source: '3 BOQs' },
  { id: 'h5', desc: 'Formwork — column', avgRate: 680, unit: 'm²', category: 'Structural', source: '4 BOQs' },
  { id: 'h6', desc: 'Formwork — slab', avgRate: 590, unit: 'm²', category: 'Structural', source: '4 BOQs' },
  { id: 'h7', desc: 'Structural steel frame — beams', avgRate: 42000, unit: 'ton', category: 'Structural', source: '2 BOQs' },
  { id: 'h8', desc: 'Metal deck flooring', avgRate: 950, unit: 'm²', category: 'Structural', source: '3 BOQs' },
  { id: 'h9', desc: 'HVAC ductwork — supply', avgRate: 1850, unit: 'm²', category: 'MEP', source: '2 BOQs' },
  { id: 'h10', desc: 'HVAC ductwork — return', avgRate: 1700, unit: 'm²', category: 'MEP', source: '2 BOQs' },
  { id: 'h11', desc: 'Electrical cable tray — 300mm', avgRate: 850, unit: 'm', category: 'MEP', source: '3 BOQs' },
  { id: 'h12', desc: 'Electrical cable — THW 50mm²', avgRate: 320, unit: 'm', category: 'MEP', source: '3 BOQs' },
  { id: 'h13', desc: 'Plumbing — PVC pipe 4"', avgRate: 280, unit: 'm', category: 'MEP', source: '4 BOQs' },
  { id: 'h14', desc: 'Fire suppression — sprinkler head', avgRate: 450, unit: 'ea', category: 'MEP', source: '2 BOQs' },
  { id: 'h15', desc: 'Ceramic tile — floor 600×600', avgRate: 680, unit: 'm²', category: 'Finishing', source: '3 BOQs' },
  { id: 'h16', desc: 'Ceramic tile — wall 300×600', avgRate: 620, unit: 'm²', category: 'Finishing', source: '3 BOQs' },
  { id: 'h17', desc: 'Paint — interior emulsion', avgRate: 85, unit: 'm²', category: 'Finishing', source: '4 BOQs' },
  { id: 'h18', desc: 'Suspended ceiling — T-grid system', avgRate: 520, unit: 'm²', category: 'Finishing', source: '2 BOQs' },
  { id: 'h19', desc: 'Door — hollow core 0.9m', avgRate: 4500, unit: 'ea', category: 'Finishing', source: '3 BOQs' },
  { id: 'h20', desc: 'Door — solid core 1.2m', avgRate: 8200, unit: 'ea', category: 'Finishing', source: '2 BOQs' },
]

const CHAT_FLOWS = [
  "Hi! I'm your BOQ Assistant. Tell me about your project — what kind of building or structure?",
  "What type of structure?<br>• <b>RC / Concrete</b><br>• <b>Steel structure</b><br>• <b>Mixed</b>",
  "How many floors? This helps estimate foundation, columns, and slabs.",
  "Does the project include any of these?<br>• Basement / underground parking<br>• MEP (HVAC, electrical, plumbing)<br>• Finishing works (tiles, paint, ceiling)<br>Let me know.",
]

export default function EstimatorPage() {
  const [projectName, setProjectName] = useState("New Estimate")
  const [projectDate, setProjectDate] = useState(new Date().toISOString().split("T")[0])
  const [projectDesc, setProjectDesc] = useState("")
  const [items, setItems] = useState<EstimateItemLocal[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([])
  const [chatWaiting, setChatWaiting] = useState(false)
  const [chatStep, setChatStep] = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const [itemModalOpen, setItemModalOpen] = useState(false)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [modalDesc, setModalDesc] = useState("")
  const [modalQty, setModalQty] = useState("1")
  const [modalRate, setModalRate] = useState("0")
  const [modalUnit, setModalUnit] = useState("")
  const [descSuggestions, setDescSuggestions] = useState<typeof HISTORICAL_ITEMS>([])

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
  }, [chatMsgs, chatWaiting])

  function addItem(item?: Partial<EstimateItemLocal>) {
    const newItem: EstimateItemLocal = {
      id: `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      desc: item?.desc || "",
      unit: item?.unit || "",
      qty: item?.qty ?? 1,
      rate: item?.rate ?? 0,
      total: (item?.qty ?? 1) * (item?.rate ?? 0),
      source: item?.source || "manual",
    }
    setItems((prev) => [...prev, newItem])
  }

  function updateItem(id: string, field: keyof EstimateItemLocal, value: string | number) {
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
            code: "",
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

  // ── Item modal ──
  function openItemModal(itemId?: string) {
    if (itemId) {
      const item = items.find((i) => i.id === itemId)
      if (!item) return
      setEditingItemId(itemId)
      setModalDesc(item.desc || "")
      setModalQty(String(item.qty))
      setModalRate(String(item.rate))
      setModalUnit(item.unit || "")
    } else {
      setEditingItemId(null)
      setModalDesc("")
      setModalQty("1")
      setModalRate("0")
      setModalUnit("")
    }
    setDescSuggestions([])
    setItemModalOpen(true)
  }

  function saveItemModal() {
    const desc = modalDesc.trim()
    if (!desc) {
      toast.error("Enter a description")
      return
    }
    const qty = parseFloat(modalQty) || 0
    const rate = parseFloat(modalRate) || 0
    const unit = modalUnit.trim()

    if (editingItemId) {
      updateItem(editingItemId, "desc", desc)
      updateItem(editingItemId, "unit", unit)
      updateItem(editingItemId, "qty", qty)
      updateItem(editingItemId, "rate", rate)
      toast.success("Item saved")
    } else {
      addItem({ desc, unit, qty, rate, source: "manual" })
      toast.success("Item added")
    }
    setItemModalOpen(false)
    setEditingItemId(null)
  }

  // ── Description autocomplete ──
  function onDescInput(value: string) {
    setModalDesc(value)
    const val = value.trim().toLowerCase()
    if (!val) {
      setDescSuggestions([])
      return
    }
    const matches = HISTORICAL_ITEMS.filter((h) => h.desc.toLowerCase().includes(val))
    setDescSuggestions(matches)
  }

  function pickDescSuggestion(h: (typeof HISTORICAL_ITEMS)[number]) {
    setModalDesc(h.desc)
    setModalRate(String(h.avgRate))
    setModalUnit(h.unit)
    setDescSuggestions([])
  }

  // ── Chat ──
  function toggleChat() {
    const next = !chatOpen
    setChatOpen(next)
    if (next && chatMsgs.length === 0) {
      setChatMsgs([{ role: "bot", text: CHAT_FLOWS[0] }])
      setChatStep(1)
    }
  }

  function sendChatMsg() {
    const text = chatInput.trim()
    if (!text || chatWaiting) return
    setChatInput("")
    setChatMsgs((prev) => [...prev, { role: "user", text }])
    setChatWaiting(true)

    setTimeout(() => {
      const t = text.toLowerCase()
      const isLong = text.length > 15
      const isConcrete = /concrete|foundation|column|slab|beam|rc/i.test(t)
      const isSteel = /steel|metal|frame/i.test(t)
      const isFinishing = /finish|tile|paint|ceiling|floor|wall|interior/i.test(t)
      const isMep = /hvac|ac|air|electrical|cable|plumbing|pipe|fire|sprinkler/i.test(t)
      const isBasement = /basement|underground|parking|excavation|pile/i.test(t)

      if (chatStep < CHAT_FLOWS.length && !isLong) {
        const flowMsg = CHAT_FLOWS[chatStep]
        const choices = chatStep === 1 ? ["RC / Concrete", "Steel structure", "Mixed"] : undefined
        setChatMsgs((prev) => [...prev, { role: "bot", text: flowMsg, choices }])
        setChatStep((s) => s + 1)
        setChatWaiting(false)
      } else {
        const sugg: ChatMessage["suggestions"] = []
        if (isBasement || isConcrete) {
          sugg.push({ desc: 'Bored pile — D0.80m x 18m', qty: 20, unit: 'm', rate: 4500 })
          sugg.push({ desc: 'Concrete C32/40 — columns', qty: 50, unit: 'm³', rate: 3850 })
          sugg.push({ desc: 'Concrete C30/37 — slabs', qty: 80, unit: 'm³', rate: 3450 })
          sugg.push({ desc: 'Rebar SD40 — 16mm', qty: 12, unit: 'ton', rate: 28500 })
          sugg.push({ desc: 'Formwork — column', qty: 300, unit: 'm²', rate: 680 })
          sugg.push({ desc: 'Formwork — slab', qty: 500, unit: 'm²', rate: 590 })
          sugg.push({ desc: 'Waterproofing membrane — basement', qty: 200, unit: 'm²', rate: 520 })
        }
        if (isSteel) {
          if (!isConcrete) sugg.push({ desc: 'Bored pile — D0.80m x 18m', qty: 16, unit: 'm', rate: 4500 })
          sugg.push({ desc: 'Steel frame — main beams', qty: 25, unit: 'ton', rate: 42000 })
          sugg.push({ desc: 'Metal deck flooring', qty: 400, unit: 'm²', rate: 950 })
        }
        if (isMep || isConcrete || isSteel) {
          sugg.push({ desc: 'HVAC ductwork — supply', qty: 150, unit: 'm²', rate: 1850 })
          sugg.push({ desc: 'Electrical cable tray — 300mm', qty: 80, unit: 'm', rate: 850 })
          sugg.push({ desc: 'Plumbing — PVC pipe 4"', qty: 120, unit: 'm', rate: 280 })
          sugg.push({ desc: 'Fire suppression — sprinkler head', qty: 30, unit: 'ea', rate: 450 })
        }
        if (isFinishing || isConcrete || isSteel) {
          sugg.push({ desc: 'Ceramic tile — floor 600×600', qty: 350, unit: 'm²', rate: 680 })
          sugg.push({ desc: 'Suspended ceiling — T-grid system', qty: 300, unit: 'm²', rate: 520 })
          sugg.push({ desc: 'Paint — interior emulsion', qty: 800, unit: 'm²', rate: 85 })
          sugg.push({ desc: 'Door — hollow core 0.9m', qty: 15, unit: 'ea', rate: 4500 })
        }
        if (sugg.length === 0) {
          sugg.push({ desc: 'Concrete C32/40 — columns', qty: 30, unit: 'm³', rate: 3850 })
          sugg.push({ desc: 'Rebar SD40 — 16mm', qty: 8, unit: 'ton', rate: 28500 })
          sugg.push({ desc: 'Formwork — slab', qty: 400, unit: 'm²', rate: 590 })
          sugg.push({ desc: 'Ceramic tile — floor 600×600', qty: 200, unit: 'm²', rate: 680 })
          sugg.push({ desc: 'Paint — interior emulsion', qty: 500, unit: 'm²', rate: 85 })
        }

        setChatMsgs((prev) => [
          ...prev,
          {
            role: "bot",
            text: "Based on your description, here are suggested items (quantities are estimates):",
            suggestions: sugg,
          },
        ])
        setChatWaiting(false)
      }
    }, 700)
  }

  function chatAddSuggestion(s: NonNullable<ChatMessage["suggestions"]>[number]) {
    addItem({ desc: s.desc, unit: s.unit, rate: s.rate, qty: s.qty, source: "manual" })
    toast.success(`Added "${s.desc}"`)
  }

  function chatAddAll(suggestions: NonNullable<ChatMessage["suggestions"]>) {
    for (const s of suggestions) {
      addItem({ desc: s.desc, unit: s.unit, rate: s.rate, qty: s.qty, source: "manual" })
    }
    toast.success(`Added ${suggestions.length} items`)
  }

  function chatChoose(choice: string) {
    setChatMsgs((prev) => [...prev, { role: "user", text: choice }])
    setChatWaiting(true)
    setTimeout(() => {
      const nextStep = chatStep
      if (nextStep < CHAT_FLOWS.length) {
        setChatMsgs((prev) => [...prev, { role: "bot", text: CHAT_FLOWS[nextStep] }])
        setChatStep((s) => s + 1)
      }
      setChatWaiting(false)
    }, 500)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm" data-od-id="estimator-loading">
        <div className="proto-spinner mr-3" />
        Loading...
      </div>
    )
  }

  return (
    <div data-od-id="estimator-page">
      <div className="est-page">
        <div className="project-meta">
          <div className="pm-group" style={{ flex: 1 }}>
            <label>Project Name</label>
            <input
              className="pm-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name…"
              data-od-id="project-name"
            />
          </div>
          <div className="pm-group">
            <label>Date of Estimate</label>
            <input
              className="pm-date"
              type="date"
              value={projectDate}
              onChange={(e) => setProjectDate(e.target.value)}
              data-od-id="project-date"
            />
          </div>
        </div>
        <div className="project-meta" style={{ marginTop: "-8px" }}>
          <div className="pm-group" style={{ flex: 1 }}>
            <label>Description</label>
            <textarea
              value={projectDesc}
              onChange={(e) => setProjectDesc(e.target.value)}
              placeholder="Project description, location, notes…"
              rows={2}
              data-od-id="project-desc"
              style={{ fontSize: "13px", padding: "6px 10px" }}
            />
          </div>
        </div>

        <div className="est-header" data-od-id="est-header">
          <h2>
            Estimate Items
            {items.length > 0 && <span className="meta" style={{ marginLeft: "8px" }}>({items.length} items)</span>}
          </h2>
          <button className="btn btn-primary btn-sm" onClick={() => openItemModal()} data-od-id="add-item-btn">
            + Add Item
          </button>
        </div>

        <div className="est-list" data-od-id="est-list">
          {items.length === 0 ? (
            <div className="empty-state" data-od-id="est-empty">
              <h3>No items added</h3>
              <p>
                Click <strong>+ Add Item</strong> to add manually, or use the chat bubble <strong>💬</strong> to
                generate items with AI.
              </p>
            </div>
          ) : (
            items.map((item) => (
              <div key={item.id} className="est-row" data-od-id={`est-row-${item.id}`} onClick={() => openItemModal(item.id)}>
                <div className="rd">
                  {item.desc || "Untitled"}
                  {item.unit && <span className="rd-sub">{item.unit}</span>}
                </div>
                <div className="rqty">{item.qty.toLocaleString()}</div>
                <div className="rrate">฿{(item.rate || 0).toLocaleString()}</div>
                <div className="rtotal">฿{item.total.toLocaleString()}</div>
                <div className="ract" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="btn btn-icon btn-ghost"
                    style={{ width: "28px", height: "28px" }}
                    data-od-id={`delete-item-${item.id}`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "14px", height: "14px" }}>
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {items.length > 0 && (
        <div className="est-summary" data-od-id="est-summary">
          <div>
            <div className="est-total-label">Estimated Total</div>
            <div className="est-total-value num">฿{totalAmount.toLocaleString()}</div>
          </div>
          <div className="est-total-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setItems([])
                toast.info("Estimate cleared")
              }}
              data-od-id="clear-estimate"
            >
              Clear
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving} data-od-id="save-estimate">
              {saving ? "Saving…" : "Save Estimate"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => window.print()} data-od-id="export-pdf">
              📄 PDF
            </button>
          </div>
        </div>
      )}

      {/* Floating chat */}
      <button className="chat-bubble-btn" onClick={toggleChat} data-od-id="chat-bubble">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </button>

      <div className={`chat-overlay ${chatOpen ? "open" : ""}`} data-od-id="chat-panel">
        <div className="chat-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          BOQ Maker Agent
          <button className="close-btn" onClick={() => setChatOpen(false)}>
            ×
          </button>
        </div>
        <div className="chat-msgs" data-od-id="chat-msgs">
          {chatMsgs.map((msg, i) => (
            <div key={i} className={`cmsg ${msg.role}`}>
              {msg.role === "bot" && <div className="clabel">BOQ Assistant</div>}
              <div dangerouslySetInnerHTML={{ __html: msg.text.replace(/\n/g, "<br/>") }} />
              {msg.choices && (
                <div className="cactions">
                  {msg.choices.map((c) => (
                    <button key={c} className="btn btn-secondary btn-xs" onClick={() => chatChoose(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
              {msg.suggestions && (
                <>
                  {msg.suggestions.map((s, si) => (
                    <div key={si} className="suggest-card">
                      <div className="sc-title">{s.desc}</div>
                      <div className="sc-meta">
                        {s.qty} {s.unit} × ฿{s.rate.toLocaleString()} = ฿{(s.qty * s.rate).toLocaleString()}
                      </div>
                      <div className="sc-actions">
                        <button className="btn btn-primary btn-xs" onClick={() => chatAddSuggestion(s)} data-od-id={`chat-add-${si}`}>
                          Add
                        </button>
                      </div>
                    </div>
                  ))}
                  <button className="btn btn-secondary btn-xs mt-1.5" onClick={() => msg.suggestions && chatAddAll(msg.suggestions)} data-od-id="chat-add-all">
                    Add All to Estimate
                  </button>
                </>
              )}
            </div>
          ))}
          {chatWaiting && (
            <div className="cmsg bot">
              <div className="typing-dots">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <div className="chat-input-area">
          <input
            className="input"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendChatMsg()
            }}
            placeholder="Describe your work…"
            data-od-id="chat-input"
          />
          <button className="btn btn-primary btn-sm" onClick={sendChatMsg} disabled={chatWaiting || !chatInput.trim()} data-od-id="chat-send">
            Send
          </button>
        </div>
      </div>

      {/* Item detail modal */}
      <div className={`modal-overlay ${itemModalOpen ? "open" : ""}`}>
        <div className="modal" style={{ maxWidth: "520px" }}>
          <div className="modal-header">
            <h3>{editingItemId ? "Edit Item" : "New Item"}</h3>
            <button className="btn btn-icon btn-ghost" onClick={() => setItemModalOpen(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "16px", height: "16px" }}>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="modal-body" style={{ padding: "var(--space-4)" }}>
            <div className="form-group">
              <label>Description</label>
              <input
                className="input"
                value={modalDesc}
                onChange={(e) => onDescInput(e.target.value)}
                placeholder="Type to search historical data or enter custom…"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveItemModal()
                }}
              />
              {descSuggestions.length > 0 && (
                <div className="desc-suggest open">
                  {descSuggestions.map((h) => (
                    <div key={h.id} className="ds-item" onClick={() => pickDescSuggestion(h)}>
                      <div className="ds-title">{h.desc}</div>
                      <div className="ds-meta">
                        {h.category} · ฿{h.avgRate.toLocaleString()}/{h.unit} · {h.source}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {modalDesc && descSuggestions.length === 0 && (
                <div className="desc-suggest open">
                  <div className="ds-empty">No historical match — type your own description</div>
                </div>
              )}
            </div>
            <div className="form-row-2">
              <div className="form-group">
                <label>Quantity</label>
                <input
                  className="input"
                  type="number"
                  value={modalQty}
                  onChange={(e) => setModalQty(e.target.value)}
                  min="0"
                  step="0.5"
                />
              </div>
              <div className="form-group">
                <label>Unit Price (฿)</label>
                <input
                  className="input"
                  type="number"
                  value={modalRate}
                  onChange={(e) => setModalRate(e.target.value)}
                  min="0"
                  step="100"
                />
              </div>
            </div>
            <div className="form-group">
              <label>Unit</label>
              <input
                className="input"
                value={modalUnit}
                onChange={(e) => setModalUnit(e.target.value)}
                placeholder="e.g. m³, ton, m²"
              />
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", marginTop: "var(--space-3)" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setItemModalOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={saveItemModal}>
                {editingItemId ? "Save Item" : "Add Item"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
