"use client"

import { useCallback, useEffect, useState, useRef } from "react"
import { toast } from "sonner"
import { normalizeEstimateItemSnapshot, type Estimate, type EstimateCatalogSnapshot } from "@/lib/estimate-schema"
import {
  buildEstimateAiManualFallback,
  catalogEntryToEstimateItem,
  standardEntryToEstimateAiCatalogEntry,
  verifyEstimateAiSuggestion,
  type EstimateAiCatalogEntry,
  type EstimateAiSuggestion,
} from "@/lib/estimate-ai"
import type { StandardEntry } from "@/lib/standard-schema"

interface EstimateItemLocal {
  id: string
  desc: string
  qty: number
  rate: number
  unit: string
  total: number
  source: "imported" | "manual" | "adjustment"
  stdId?: string
  stdSnapshot?: EstimateCatalogSnapshot
}

interface ChatMessage {
  id: string
  role: "user" | "bot"
  text: string
  suggestions?: EstimateAiSuggestion[]
}

type CatalogSelection = Pick<StandardEntry, "id" | "description" | "unit">

/** True while the New Item dialog should run a catalog search for `desc`.
 * Skips closed modals, sub-2-char text, and the post-pick state where the
 * description already equals the selected standard (so the dropdown stays
 * closed and no "no match" flash re-appears after selecting a suggestion). */
export function shouldSearchDescSuggestions(input: {
  modalOpen: boolean
  desc: string
  selectedStandard: CatalogSelection | null
}): boolean {
  if (!input.modalOpen) return false
  const desc = input.desc.trim()
  if (desc.length < 2) return false
  if (input.selectedStandard && desc === input.selectedStandard.description.trim()) return false
  return true
}

export type DescSuggestionNotice =
  | { kind: "hidden" }
  | { kind: "searching" }
  | { kind: "selected"; description: string }
  | { kind: "no-match" }

/** What the description combobox should say below the input. Distinguishes
 * "still searching" from "genuinely no match" and never reports "no match"
 * once a catalog standard has been picked for the current description. */
export function descSuggestionNotice(input: {
  desc: string
  suggestions: number
  loading: boolean
  selectedStandard: CatalogSelection | null
  searchedFor: string
}): DescSuggestionNotice {
  const desc = input.desc.trim()
  if (desc.length === 0) return { kind: "hidden" }
  if (input.selectedStandard && desc === input.selectedStandard.description.trim()) {
    return { kind: "selected", description: input.selectedStandard.description }
  }
  if (input.suggestions > 0) return { kind: "hidden" }
  if (input.loading || input.searchedFor.trim() !== desc) return { kind: "searching" }
  return { kind: "no-match" }
}

function makeId(prefix = "e") {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function finiteNonNegative(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function normalizeEstimateItems(items: Estimate["items"] | undefined): EstimateItemLocal[] {
  if (!Array.isArray(items)) return []
  return items.map((item, index) => {
    const qty = finiteNonNegative(item.qty)
    const rate = finiteNonNegative(item.rate)
    const source = item.source === "imported" || item.source === "adjustment" ? item.source : "manual"
    const stdId = typeof item.stdId === "string" && item.stdId.length > 0 ? item.stdId : undefined
    return {
      id: `${item.code || "saved"}-${index}`,
      desc: typeof item.desc === "string" ? item.desc : "",
      unit: typeof item.unit === "string" ? item.unit : "",
      qty,
      rate,
      total: qty * rate,
      source,
      stdId,
      stdSnapshot: normalizeEstimateItemSnapshot(item),
    }
  })
}

/** An estimate that has been saved once is updated in place; only a new estimate is created. */
export function estimateSaveRequest(estimateId: string | null): { url: string; method: "POST" | "PUT" } {
  return estimateId
    ? { url: `/api/estimates/${encodeURIComponent(estimateId)}`, method: "PUT" }
    : { url: "/api/estimates", method: "POST" }
}

function savedEstimateLabel(estimate: Estimate) {
  const lines = Array.isArray(estimate.items) ? estimate.items.length : 0
  return `${estimate.name || "Untitled estimate"} · ${estimate.date || "No date"} · ${lines} ${lines === 1 ? "line" : "lines"}`
}

export function toEstimateItemPayload(item: EstimateItemLocal): Estimate["items"][number] {
  return {
    code: "",
    desc: item.desc,
    unit: item.unit,
    qty: item.qty,
    rate: item.rate,
    total: item.total,
    source: item.source,
    ...(item.stdId ? { stdId: item.stdId } : {}),
    ...(item.stdSnapshot ? { stdSnapshot: item.stdSnapshot } : {}),
  }
}

function BotMessageText({ text }: { text: string }) {
  const lines = text.replace(/<br\s*\/?\s*>/gi, "\n").split("\n")
  return lines.map((line, index) => {
    const clean = line.replace(/<\/?b>/gi, "")
    const bullet = clean.trim().startsWith("•")
    return (
      <span key={`${index}-${clean}`} className={bullet ? "chat-line chat-line-bullet" : "chat-line"}>
        {clean}
      </span>
    )
  })
}

export default function EstimatorPage() {
  const [projectName, setProjectName] = useState("New Estimate")
  const [projectDate, setProjectDate] = useState(new Date().toISOString().split("T")[0])
  const [projectDesc, setProjectDesc] = useState("")
  const [items, setItems] = useState<EstimateItemLocal[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [saving, setSaving] = useState(false)
  const saveInFlightRef = useRef(false)
  const saveRequestRef = useRef(0)
  const editRevisionRef = useRef(0)
  // The edit revision last loaded or saved; a different current revision means unsaved changes.
  const savedRevisionRef = useRef(0)
  const [estimateId, setEstimateId] = useState<string | null>(null)
  const [savedEstimates, setSavedEstimates] = useState<Estimate[]>([])

  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([])
  const [chatWaiting, setChatWaiting] = useState(false)
  const [chatError, setChatError] = useState("")
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const chatAbortRef = useRef<AbortController | null>(null)

  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState("")
  const [catalogEntries, setCatalogEntries] = useState<StandardEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState("")
  const [chatCatalogLoading, setChatCatalogLoading] = useState(false)
  const catalogLoadedRef = useRef(false)
  const catalogEntriesRef = useRef<StandardEntry[]>([])
  const catalogFetchSeqRef = useRef(0)

  const [itemModalOpen, setItemModalOpen] = useState(false)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [modalDesc, setModalDesc] = useState("")
  const [modalQty, setModalQty] = useState("1")
  const [modalRate, setModalRate] = useState("0")
  const [modalUnit, setModalUnit] = useState("")
  const [descSuggestions, setDescSuggestions] = useState<StandardEntry[]>([])
  const [descSearchedFor, setDescSearchedFor] = useState("")
  const [selectedModalStandard, setSelectedModalStandard] = useState<CatalogSelection | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [itemError, setItemError] = useState("")
  const modalRef = useRef<HTMLDivElement>(null)
  const modalDescRef = useRef<HTMLInputElement>(null)
  const modalTriggerRef = useRef<HTMLElement | null>(null)

  function claimEdit() {
    if (saveInFlightRef.current) return false
    editRevisionRef.current += 1
    return true
  }

  const fillForm = useCallback((estimate: Estimate | null) => {
    setProjectName(estimate?.name || "New Estimate")
    setProjectDate(estimate ? estimate.date || "" : new Date().toISOString().split("T")[0])
    setProjectDesc(estimate?.notes || "")
    setItems(normalizeEstimateItems(estimate?.items))
    savedRevisionRef.current = editRevisionRef.current
  }, [])

  const fetchEstimates = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setLoadError("")
    try {
      const res = await fetch("/api/estimates", { signal })
      if (!res.ok) throw new Error("Could not load your latest estimate")
      const data = (await res.json()) as { estimates?: Estimate[] }
      const list = Array.isArray(data.estimates) ? data.estimates : []
      setSavedEstimates(list)
      const last = list[0]
      if (last) {
        setEstimateId(last.id)
        fillForm(last)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setLoadError("Could not load your latest estimate. Check your connection and try again.")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [fillForm])

  useEffect(() => {
    const controller = new AbortController()
    void Promise.resolve().then(() => fetchEstimates(controller.signal))
    return () => controller.abort()
  }, [fetchEstimates])

  const fetchCatalog = useCallback(async (search: string, signal?: AbortSignal): Promise<StandardEntry[]> => {
    const seq = ++catalogFetchSeqRef.current
    setCatalogLoading(true)
    setCatalogError("")
    try {
      const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ""
      const response = await fetch(`/api/standards${query}`, { signal })
      if (!response.ok) throw new Error("Could not load the Standard Catalog")
      const data = await response.json() as unknown
      const entries = Array.isArray(data)
        ? data.filter((entry): entry is StandardEntry => (
          typeof entry === "object"
          && entry !== null
          && typeof (entry as StandardEntry).id === "string"
          && typeof (entry as StandardEntry).description === "string"
          && typeof (entry as StandardEntry).unit === "string"
          && !(entry as StandardEntry).archivedAt
        ))
        : []
      if (signal?.aborted) return []
      catalogLoadedRef.current = true
      catalogEntriesRef.current = entries
      setCatalogEntries(entries)
      return entries
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return []
      if (!signal?.aborted) {
        catalogLoadedRef.current = true
        setCatalogError("Could not load the Standard Catalog. Try again.")
      }
      return []
    } finally {
      // The latest request owns the shared loading flag, so an aborted fetch
      // (e.g. a suggestion pick cancels an in-flight search) still settles it.
      if (seq === catalogFetchSeqRef.current) setCatalogLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!catalogOpen) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => void fetchCatalog(catalogSearch, controller.signal), 220)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [catalogOpen, catalogSearch, fetchCatalog])

  useEffect(() => {
    if (!shouldSearchDescSuggestions({ modalOpen: itemModalOpen, desc: modalDesc, selectedStandard: selectedModalStandard })) return
    const query = modalDesc
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      const entries = await fetchCatalog(query, controller.signal)
      if (controller.signal.aborted) return
      setDescSuggestions(entries.slice(0, 8))
      setActiveSuggestion(entries.length > 0 ? 0 : -1)
      setDescSearchedFor(query.trim())
    }, 220)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [fetchCatalog, itemModalOpen, modalDesc, selectedModalStandard])

  useEffect(() => () => chatAbortRef.current?.abort(), [])

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [chatMsgs, chatWaiting])

  useEffect(() => {
    if (chatOpen) chatInputRef.current?.focus()
  }, [chatOpen])

  useEffect(() => {
    if (activeSuggestion < 0) return
    const suggestion = descSuggestions[activeSuggestion]
    if (!suggestion) return
    document.getElementById(`est-suggestion-${suggestion.id}`)?.scrollIntoView({ block: "nearest" })
  }, [activeSuggestion, descSuggestions])

  useEffect(() => {
    if (!itemModalOpen) return
    const dialog = modalRef.current
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [])
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        closeItemModal()
      }
      if (event.key !== "Tab") return
      const controls = focusable()
      if (controls.length === 0) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    const timer = window.setTimeout(() => modalDescRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [itemModalOpen])

  function addItem(id: string, item?: Partial<EstimateItemLocal>) {
    if (!claimEdit()) return false
    const desc = item?.desc || ""
    const unit = item?.unit || ""
    const qty = finiteNonNegative(item?.qty ?? 1)
    const rate = finiteNonNegative(item?.rate ?? 0)
    const newItem: EstimateItemLocal = {
      id,
      desc,
      unit,
      qty,
      rate,
      total: qty * rate,
      source: item?.source || "manual",
      stdId: item?.stdId,
      stdSnapshot: item?.stdSnapshot || (item?.stdId && desc && unit ? { description: desc, unit } : undefined),
    }
    setItems((prev) => [...prev, newItem])
    return true
  }

  function updateItem(id: string, field: keyof EstimateItemLocal, value: EstimateItemLocal[keyof EstimateItemLocal]) {
    if (!claimEdit()) return
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        const updated = { ...item, [field]: value }
        if (field === "qty" || field === "rate") {
          const q = field === "qty" ? finiteNonNegative(value) : item.qty
          const r = field === "rate" ? finiteNonNegative(value) : item.rate
          if (field === "qty") updated.qty = q
          if (field === "rate") updated.rate = r
          updated.total = q * r
        }
        return updated
      })
    )
  }

  function removeItem(id: string) {
    if (saveInFlightRef.current) return
    const item = items.find((candidate) => candidate.id === id)
    if (!item || !window.confirm(`Delete “${item.desc || "Untitled item"}”?`)) return
    if (!claimEdit()) return
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  const totalAmount = items.reduce((sum, i) => sum + i.total, 0)
  const descNotice = descSuggestionNotice({
    desc: modalDesc,
    suggestions: descSuggestions.length,
    loading: catalogLoading,
    selectedStandard: selectedModalStandard,
    searchedFor: descSearchedFor,
  })

  async function handleSave() {
    if (saveInFlightRef.current) return
    if (items.length === 0) {
      toast.error("Add at least one item")
      return
    }
    const requestId = ++saveRequestRef.current
    const savedRevision = editRevisionRef.current
    saveInFlightRef.current = true
    setSaving(true)
    const request = estimateSaveRequest(estimateId)
    try {
      const res = await fetch(request.url, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: projectName || "New Estimate",
          project: projectName,
          date: projectDate,
          notes: projectDesc,
          items: items.map(toEstimateItemPayload),
        }),
      })
      if (!res.ok) throw new Error("Save failed")
      const saved = (await res.json()) as Estimate | null
      if (!saved?.id) throw new Error("Save response was incomplete")
      // Later saves update this same estimate instead of creating another copy.
      setEstimateId(saved.id)
      setSavedEstimates((prev) => [saved, ...prev.filter((estimate) => estimate.id !== saved.id)])
      if (savedRevision !== editRevisionRef.current) {
        toast.warning("Estimate changed while saving. Save again to include the latest edits.")
        return
      }
      savedRevisionRef.current = savedRevision
      toast.success(request.method === "POST" ? "Estimate created" : "Estimate saved")
    } catch {
      toast.error("Failed to save estimate")
    } finally {
      if (requestId === saveRequestRef.current) {
        saveInFlightRef.current = false
        setSaving(false)
      }
    }
  }

  // ── Switching estimates ──
  function confirmDiscardUnsaved() {
    if (editRevisionRef.current === savedRevisionRef.current) return true
    return window.confirm(`Discard unsaved changes to “${projectName || "this estimate"}”?`)
  }

  function startNewEstimate() {
    if (saveInFlightRef.current || !confirmDiscardUnsaved()) return
    setEstimateId(null)
    fillForm(null)
  }

  function openSavedEstimate(id: string) {
    if (saveInFlightRef.current || id === estimateId) return
    const estimate = savedEstimates.find((candidate) => candidate.id === id)
    if (!estimate || !confirmDiscardUnsaved()) return
    setEstimateId(estimate.id)
    fillForm(estimate)
  }

  // ── Item modal ──
  function openItemModal(itemId?: string) {
    if (saveInFlightRef.current) return
    modalTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (itemId) {
      const item = items.find((i) => i.id === itemId)
      if (!item) return
      setEditingItemId(itemId)
      setModalDesc(item.desc || "")
      setModalQty(String(item.qty))
      setModalRate(String(item.rate))
      setModalUnit(item.unit || "")
      setSelectedModalStandard(item.stdId ? {
        id: item.stdId,
        description: item.stdSnapshot?.description ?? item.desc,
        unit: item.stdSnapshot?.unit ?? item.unit,
      } : null)
    } else {
      setEditingItemId(null)
      setModalDesc("")
      setModalQty("1")
      setModalRate("0")
      setModalUnit("")
      setSelectedModalStandard(null)
    }
    setDescSuggestions([])
    setDescSearchedFor("")
    setActiveSuggestion(-1)
    setItemError("")
    setItemModalOpen(true)
  }

  function closeItemModal() {
    setItemModalOpen(false)
    setEditingItemId(null)
    setSelectedModalStandard(null)
    setDescSuggestions([])
    setDescSearchedFor("")
    setActiveSuggestion(-1)
    setItemError("")
    window.setTimeout(() => modalTriggerRef.current?.focus(), 0)
  }

  function saveItemModal() {
    if (saveInFlightRef.current) return
    const desc = modalDesc.trim()
    if (!desc) {
      setItemError("Enter a description.")
      modalDescRef.current?.focus()
      return
    }
    const qty = Number(modalQty)
    const rate = Number(modalRate)
    if (!modalQty.trim() || !modalRate.trim() || !Number.isFinite(qty) || qty < 0 || !Number.isFinite(rate) || rate < 0) {
      setItemError("Quantity and unit price must be zero or greater.")
      return
    }
    const unit = modalUnit.trim()

    if (editingItemId) {
      updateItem(editingItemId, "desc", desc)
      updateItem(editingItemId, "unit", unit)
      updateItem(editingItemId, "qty", qty)
      updateItem(editingItemId, "rate", rate)
      if (selectedModalStandard) {
        updateItem(editingItemId, "stdId", selectedModalStandard.id)
        updateItem(editingItemId, "stdSnapshot", { description: selectedModalStandard.description, unit: selectedModalStandard.unit })
      }
      toast.success("Item saved")
    } else {
      addItem(`e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, {
        desc, unit, qty, rate, source: "manual",
        ...(selectedModalStandard ? {
          stdId: selectedModalStandard.id,
          stdSnapshot: { description: selectedModalStandard.description, unit: selectedModalStandard.unit },
        } : {}),
      })
      toast.success("Item added")
    }
    closeItemModal()
  }

  // ── Description autocomplete ──
  function onDescInput(value: string) {
    if (saveInFlightRef.current) return
    setModalDesc(value)
    setSelectedModalStandard(null)
    setItemError("")
    if (!value.trim()) {
      setDescSuggestions([])
      setActiveSuggestion(-1)
      return
    }
  }

  function pickDescSuggestion(h: StandardEntry) {
    if (saveInFlightRef.current) return
    setModalDesc(h.description)
    setModalUnit(h.unit)
    setModalRate(String(h.historicalPricing?.average ?? 0))
    setSelectedModalStandard(h)
    setDescSuggestions([])
    setActiveSuggestion(-1)
  }

  function getAiCatalogContext(entries = catalogEntriesRef.current) {
    const available = entries.slice(0, 80).map(standardEntryToEstimateAiCatalogEntry)
    const selectedById = new Map<string, EstimateAiCatalogEntry>()
    for (const item of items) {
      if (!item.stdId) continue
      const description = item.stdSnapshot?.description || item.desc
      const unit = item.stdSnapshot?.unit || item.unit
      if (!description || !unit || selectedById.has(item.stdId)) continue
      selectedById.set(item.stdId, {
        id: item.stdId,
        description,
        unit,
        defaultQty: item.qty,
        defaultRate: item.rate,
      })
    }
    return { available, selected: Array.from(selectedById.values()) }
  }

  function addCatalogEntry(entry: StandardEntry) {
    if (saving) return
    if (items.some((item) => item.stdId === entry.id)) {
      toast.info("That catalog item is already in the estimate")
      return
    }
    const row = catalogEntryToEstimateItem(standardEntryToEstimateAiCatalogEntry(entry))
    if (!addItem(makeId("catalog-"), row)) return
    toast.success(`Added "${entry.description}" from the Standard Catalog`)
  }

  function toggleChat() {
    if (chatOpen) {
      closeChat()
      return
    }
    setChatOpen(true)
    setChatError("")
    if (chatMsgs.length === 0) {
      setChatMsgs([{
        id: makeId("chat-"),
        role: "bot",
        text: "Tell me about the project scope, building type, quantities, units, or rates. I’ll return catalog-backed and manual suggestions for your review.",
      }])
    }
  }

  function closeChat() {
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
    setChatWaiting(false)
    setChatOpen(false)
  }

  function isEstimateAiSuggestion(value: unknown): value is EstimateAiSuggestion {
    if (!value || typeof value !== "object") return false
    const suggestion = value as Partial<EstimateAiSuggestion>
    return typeof suggestion.description === "string"
      && typeof suggestion.unit === "string"
      && typeof suggestion.quantity === "number"
      && Number.isFinite(suggestion.quantity)
      && suggestion.quantity >= 0
      && typeof suggestion.rate === "number"
      && Number.isFinite(suggestion.rate)
      && suggestion.rate >= 0
      && (suggestion.source === "catalog" || suggestion.source === "manual")
      && typeof suggestion.reason === "string"
  }

  async function sendChatMsg(message = chatInput) {
    const text = message.trim()
    if (!text || chatWaiting) return
    setChatInput("")
    setChatError("")
    setChatMsgs((prev) => [...prev, { id: makeId("chat-"), role: "user", text }])
    setChatWaiting(true)
    const controller = new AbortController()
    chatAbortRef.current = controller

    try {
      let entriesForChat = catalogEntries
      if (!catalogLoadedRef.current || Boolean(catalogError) || entriesForChat.length === 0) {
        setChatCatalogLoading(true)
        entriesForChat = await fetchCatalog("", controller.signal)
        setChatCatalogLoading(false)
        if (controller.signal.aborted) return
      }
      if (entriesForChat.length === 0) {
        setChatError("No active Standard Catalog entries are available. Suggestions will be manual/new items.")
      }
      const context = getAiCatalogContext(entriesForChat)
      const history = [
        ...chatMsgs,
        { id: "pending-user-message", role: "user" as const, text },
      ].slice(-20).map((msg) => ({
        role: msg.role === "bot" ? "assistant" as const : "user" as const,
        content: msg.suggestions?.length
          ? `${msg.text}\nSuggestions: ${JSON.stringify(msg.suggestions)}`
          : msg.text,
      }))
      const response = await fetch("/api/llm/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          estimate: {
            projectName,
            date: projectDate,
            notes: projectDesc,
            items: items.map(toEstimateItemPayload),
          },
          catalog: context,
          history,
        }),
      })
      const data = await response.json() as { assistantText?: unknown; suggestions?: unknown; fallback?: unknown; error?: unknown }
      const suggestions = Array.isArray(data.suggestions) ? data.suggestions.filter(isEstimateAiSuggestion) : []
      const isFallback = data.fallback === true
      if ((!response.ok && !isFallback) || (!isFallback && suggestions.length === 0)) throw new Error("AI assistant unavailable")
      setChatMsgs((prev) => [...prev, {
        id: makeId("chat-"),
        role: "bot",
        text: typeof data.assistantText === "string" && data.assistantText.trim() ? data.assistantText : "Here are suggestions for your review.",
        suggestions,
      }])
      if (isFallback) {
        setChatError(typeof data.error === "string" && data.error.trim()
          ? data.error
          : "AI suggestions are unavailable. Review the manual/new item below.")
      }
    } catch {
      if (controller.signal.aborted) return
      const fallback = buildEstimateAiManualFallback("The AI assistant is unavailable right now.")
      setChatMsgs((prev) => [...prev, {
        id: makeId("chat-"),
        role: "bot",
        text: fallback.assistantText,
        suggestions: fallback.suggestions,
      }])
      setChatError("The AI assistant is unavailable. Review the manual/new item below or add an item manually.")
    } finally {
      setChatCatalogLoading(false)
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null
        setChatWaiting(false)
        chatInputRef.current?.focus()
      }
    }
  }

  function chatAddSuggestion(suggestion: EstimateAiSuggestion) {
    if (saveInFlightRef.current) return
    const verified = verifyEstimateAiSuggestion(suggestion, [
      ...getAiCatalogContext().available,
      ...getAiCatalogContext().selected,
    ])
    const catalogBacked = verified.source === "catalog" && Boolean(verified.stdId)
    if (catalogBacked && items.some((item) => item.stdId === verified.stdId)) {
      toast.info("That catalog item is already in the estimate")
      return
    }
    const label = catalogBacked ? "catalog-backed item" : "manual/new item"
    if (!window.confirm(`Review and add this ${label}?\n\n${verified.description}\n${verified.quantity} ${verified.unit} × ฿${verified.rate.toLocaleString()}`)) return
    const added = addItem(makeId("ai-"), {
      desc: verified.description,
      unit: verified.unit,
      qty: verified.quantity,
      rate: verified.rate,
      source: catalogBacked ? "imported" : "manual",
      stdId: catalogBacked ? verified.stdId : undefined,
      stdSnapshot: catalogBacked ? { description: verified.description, unit: verified.unit } : undefined,
    })
    if (!added) return
    toast.success(`Added "${verified.description}"`)
    setChatMsgs((prev) => [...prev, { id: makeId("chat-"), role: "bot", text: `Added ${verified.description}. You can edit its quantity or rate in the estimate.` }])
  }

  function chatAddAll(suggestions: EstimateAiSuggestion[]) {
    if (saveInFlightRef.current) return
    const context = getAiCatalogContext()
    const verified = suggestions.map((suggestion) => verifyEstimateAiSuggestion(suggestion, [...context.available, ...context.selected]))
    const existingCatalogIds = new Set(items.flatMap((item) => item.stdId ? [item.stdId] : []))
    const pending = verified.filter((suggestion) => {
      if (!suggestion.stdId) return true
      if (existingCatalogIds.has(suggestion.stdId)) return false
      existingCatalogIds.add(suggestion.stdId)
      return true
    })
    if (pending.length === 0) {
      toast.info("All catalog-backed suggestions are already in the estimate")
      return
    }
    const preview = pending.slice(0, 5).map((suggestion) => `• ${suggestion.description}`).join("\n")
    const suffix = pending.length > 5 ? `\n• +${pending.length - 5} more` : ""
    if (!window.confirm(`Review and add ${pending.length} suggested item${pending.length === 1 ? "" : "s"}?\n\n${preview}${suffix}`)) return
    let added = 0
    for (const suggestion of pending) {
      const catalogBacked = suggestion.source === "catalog" && Boolean(suggestion.stdId)
      if (addItem(makeId("ai-"), {
        desc: suggestion.description,
        unit: suggestion.unit,
        qty: suggestion.quantity,
        rate: suggestion.rate,
        source: catalogBacked ? "imported" : "manual",
        stdId: catalogBacked ? suggestion.stdId : undefined,
        stdSnapshot: catalogBacked ? { description: suggestion.description, unit: suggestion.unit } : undefined,
      })) added += 1
    }
    if (added > 0) {
      toast.success(`Added ${added} reviewed item${added === 1 ? "" : "s"}`)
      setChatMsgs((prev) => [...prev, { id: makeId("chat-"), role: "bot", text: "Reviewed suggestions added. Adjust quantities and rates before saving." }])
    }
  }

  function refineChat() {
    setChatInput("Please refine the previous suggestions with more precise quantities and rates.")
    chatInputRef.current?.focus()
  }

  if (loading) {
    return (
      <div className="estimator-loading" data-od-id="estimator-loading" role="status">
        <div className="proto-spinner" />
        Loading estimate…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="proto-empty-state estimator-load-error" data-od-id="estimator-error" role="alert">
        <h3>Estimate unavailable</h3>
        <p>{loadError}</p>
        <button className="btn btn-primary btn-sm" onClick={() => void fetchEstimates()}>Retry</button>
      </div>
    )
  }

  return (
    <div className={`estimator-workspace${items.length > 0 ? " has-summary" : ""}`} data-od-id="estimator-page">
      <div className="est-page">
        <div className="estimate-switcher" data-od-id="estimate-switcher">
          <label htmlFor="estimate-open">Saved estimates</label>
          <select
            id="estimate-open"
            className="proto-select"
            value={estimateId ?? ""}
            onChange={(event) => openSavedEstimate(event.target.value)}
            disabled={saving || savedEstimates.length === 0}
            data-od-id="estimate-open"
          >
            {estimateId === null && <option value="">New estimate (not saved yet)</option>}
            {savedEstimates.map((estimate) => (
              <option key={estimate.id} value={estimate.id}>{savedEstimateLabel(estimate)}</option>
            ))}
          </select>
          <button type="button" className="btn btn-secondary btn-sm" onClick={startNewEstimate} disabled={saving} data-od-id="new-estimate">
            New estimate
          </button>
        </div>
        <div className="project-meta">
          <div className="pm-group" style={{ flex: 1 }}>
            <label>Project Name</label>
            <input
              className="pm-name"
              value={projectName}
              onChange={(e) => {
                if (!claimEdit()) return
                setProjectName(e.target.value)
              }}
              disabled={saving}
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
              onChange={(e) => {
                if (!claimEdit()) return
                setProjectDate(e.target.value)
              }}
              disabled={saving}
              data-od-id="project-date"
            />
          </div>
        </div>
        <div className="project-meta" style={{ marginTop: "-8px" }}>
          <div className="pm-group" style={{ flex: 1 }}>
            <label>Description</label>
            <textarea
              value={projectDesc}
              onChange={(e) => {
                if (!claimEdit()) return
                setProjectDesc(e.target.value)
              }}
              disabled={saving}
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
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setCatalogOpen((open) => !open)}
              disabled={saving}
              aria-expanded={catalogOpen}
              aria-controls="estimator-catalog-picker"
              data-od-id="catalog-picker-toggle"
            >
              {catalogOpen ? "Hide Catalog" : "Browse Catalog"}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => openItemModal()} disabled={saving} data-od-id="add-item-btn">
              + Add Item
            </button>
          </div>
        </div>

        {catalogOpen && (
          <section
            id="estimator-catalog-picker"
            className="proto-card"
            aria-labelledby="estimator-catalog-title"
            data-od-id="estimator-catalog-picker"
            style={{ marginBottom: "var(--space-3)", padding: "var(--space-3)" }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-2)" }}>
              <div>
                <h3 id="estimator-catalog-title" style={{ margin: 0, fontSize: "var(--text-sm)" }}>Standard Catalog</h3>
                <p className="meta" style={{ margin: "3px 0 0" }}>Add an active catalog item as a saved snapshot.</p>
              </div>
              <span className="meta" aria-live="polite">{items.filter((item) => item.stdId).length} linked</span>
            </div>
            <label htmlFor="estimator-catalog-search" className="meta">Search active catalog entries</label>
            <input
              id="estimator-catalog-search"
              className="input"
              value={catalogSearch}
              onChange={(event) => setCatalogSearch(event.target.value)}
              placeholder="Search by description, unit, or alias…"
              autoComplete="off"
              data-od-id="catalog-search"
            />
            {catalogLoading && <div role="status" className="settings-row-status" style={{ padding: "var(--space-3) 0 0" }}>Loading active catalog entries…</div>}
            {catalogError && (
              <div role="alert" className="catalog-modal-error" style={{ marginTop: "var(--space-2)" }}>
                <span>{catalogError}</span>
                <button className="btn btn-ghost btn-xs" onClick={() => void fetchCatalog(catalogSearch)} data-od-id="catalog-retry">Retry</button>
              </div>
            )}
            {!catalogLoading && !catalogError && catalogEntries.length === 0 && (
              <div className="proto-empty-state" style={{ padding: "var(--space-4) var(--space-2)" }} data-od-id="catalog-empty">
                No active catalog entries match that search.
              </div>
            )}
            {!catalogLoading && !catalogError && catalogEntries.length > 0 && (
              <div role="list" aria-label="Active Standard Catalog entries" data-od-id="catalog-results" style={{ marginTop: "var(--space-2)", maxHeight: "210px", overflowY: "auto", borderTop: "1px solid var(--border-soft)" }}>
                {catalogEntries.map((entry) => {
                  const alreadyAdded = items.some((item) => item.stdId === entry.id)
                  return (
                    <div key={entry.id} role="listitem" aria-label={`${entry.description}, ${entry.unit}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-soft)" }}>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.description}</strong>
                        <span className="meta">{entry.unit}{entry.category ? ` · ${entry.category}` : ""}</span>
                        <span className="meta" style={{ display: "block", marginTop: 2 }}>
                          {entry.historicalPricing
                            ? `Approved average ฿${entry.historicalPricing.average.toLocaleString(undefined, { maximumFractionDigits: 2 })} / ${entry.unit} · ${entry.historicalPricing.count} ${entry.historicalPricing.count === 1 ? "rate" : "rates"}`
                            : "No approved history · rate starts at ฿0"}
                        </span>
                      </div>
                      <button
                        className={alreadyAdded ? "btn btn-ghost btn-xs" : "btn btn-secondary btn-xs"}
                        onClick={() => addCatalogEntry(entry)}
                        disabled={saving}
                        aria-label={`${alreadyAdded ? "Catalog item already added" : "Add"} ${entry.description}`}
                        data-od-id={`catalog-add-${entry.id}`}
                      >
                        {alreadyAdded ? "Added" : "Add"}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}

        <div className="est-list" data-od-id="est-list">
          {items.length === 0 ? (
            <div className="proto-empty-state estimator-empty" data-od-id="est-empty">
              <h3>No items added</h3>
              <p>
                Click <strong>+ Add Item</strong> to add manually, or use the chat bubble <strong>💬</strong> to
                generate items with AI.
              </p>
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="est-row"
                data-od-id={`est-row-${item.id}`}
                role="button"
                tabIndex={saving ? -1 : 0}
                aria-disabled={saving}
                aria-label={`Edit ${item.desc || "untitled item"}`}
                onClick={() => openItemModal(item.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    openItemModal(item.id)
                  }
                }}
              >
                <div className="rd">
                  {item.desc || "Untitled"}
                  {item.unit && <span className="rd-sub">{item.unit}</span>}
                  {item.stdId && <span className="rd-sub" data-od-id={`snapshot-label-${item.id}`}>Catalog snapshot</span>}
                </div>
                <div className="rqty">{item.qty.toLocaleString()}</div>
                <div className="rrate">฿{(item.rate || 0).toLocaleString()}</div>
                <div className="rtotal">฿{item.total.toLocaleString()}</div>
                <div className="ract" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="btn btn-icon btn-ghost"
                    disabled={saving}
                    style={{ width: "28px", height: "28px" }}
                    data-od-id={`delete-item-${item.id}`}
                    aria-label={`Delete ${item.desc || "untitled item"}`}
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
              disabled={saving}
              onClick={() => {
                if (saveInFlightRef.current) return
                if (!window.confirm("Clear every item from this estimate?")) return
                if (!claimEdit()) return
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
      {items.length > 0 && (
        <div className="est-print-total num" data-od-id="est-print-total">
          Estimated Total: ฿{totalAmount.toLocaleString()}
        </div>
      )}

      {/* Floating chat */}
      <button className="chat-bubble-btn" onClick={toggleChat} data-od-id="chat-bubble" aria-label={chatOpen ? "Close BOQ assistant" : "Open BOQ assistant"} aria-expanded={chatOpen} aria-controls="boq-chat-panel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </button>

      <div id="boq-chat-panel" className={`chat-overlay ${chatOpen ? "open" : ""}`} data-od-id="chat-panel" role="dialog" aria-modal="false" aria-labelledby="estimate-chat-title" aria-hidden={!chatOpen} hidden={!chatOpen}>
        <div className="chat-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          <span id="estimate-chat-title">Estimate Builder AI</span>
          <button className="close-btn" onClick={closeChat} aria-label="Close BOQ assistant">
            ×
          </button>
        </div>
        <div className="chat-msgs" data-od-id="chat-msgs">
          {chatMsgs.map((msg) => (
            <div key={msg.id} className={`cmsg ${msg.role}`} data-od-id={`chat-message-${msg.id}`}>
              {msg.role === "bot" && <div className="clabel">Estimate Builder AI</div>}
              <div>{msg.role === "bot" ? <BotMessageText text={msg.text} /> : msg.text}</div>
              {msg.suggestions && (
                <>
                  {msg.suggestions.map((s, si) => (
                    <div key={si} className="suggest-card">
                      <div className="sc-title">{s.description}</div>
                      <div className="sc-meta">
                        {s.source === "catalog" ? "Catalog-backed" : "Manual/new"} · {s.quantity} {s.unit} × ฿{s.rate.toLocaleString()} = ฿{(s.quantity * s.rate).toLocaleString()}
                      </div>
                      <div className="meta" style={{ marginBottom: "var(--space-2)" }}>{s.reason}</div>
                      <div className="sc-actions">
                        <button className="btn btn-primary btn-xs" onClick={() => chatAddSuggestion(s)} disabled={saving} data-od-id={`chat-verify-add-${msg.id}-${si}`}>
                          Verify &amp; add
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="chat-suggestion-total num">Total: ฿{msg.suggestions.reduce((sum, suggestion) => sum + suggestion.quantity * suggestion.rate, 0).toLocaleString()}</div>
                  <div className="cactions">
                    <button className="btn btn-primary btn-xs" onClick={() => msg.suggestions && chatAddAll(msg.suggestions)} disabled={saving} data-od-id={`chat-verify-add-all-${msg.id}`}>
                      Verify &amp; add all
                    </button>
                    <button className="btn btn-ghost btn-xs" onClick={refineChat}>Refine</button>
                  </div>
                </>
              )}
            </div>
          ))}
          {chatCatalogLoading && (
            <div className="catalog-modal-error" role="status" data-od-id="chat-catalog-loading">Loading active Standard Catalog context…</div>
          )}
          {chatWaiting && (
            <div className="cmsg bot" data-od-id={`chat-message-thinking-${chatMsgs.length}`}>
              <div className="clabel">Estimate Builder AI</div>
              <div className="typing-dots">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          {chatError && <div className="catalog-modal-error" role="alert" data-od-id="chat-error">{chatError}</div>}
          <div ref={chatEndRef} />
        </div>
        <div className="chat-input-area">
          <input
            ref={chatInputRef}
            className="input"
            value={chatInput}
            disabled={!chatOpen || chatWaiting}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendChatMsg()
            }}
            placeholder="Describe your work…"
            data-od-id="chat-input"
            aria-label="Message Estimate Builder AI"
          />
          <button className="btn btn-primary btn-sm" onClick={() => void sendChatMsg()} disabled={!chatOpen || chatWaiting || !chatInput.trim()} data-od-id="chat-send">
            Send
          </button>
        </div>
      </div>

      {/* Item detail modal */}
      {itemModalOpen && <div className="modal-overlay open" onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeItemModal()
      }}>
        <div ref={modalRef} className="modal estimator-item-modal" role="dialog" aria-modal="true" aria-labelledby="estimator-item-modal-title">
          <div className="modal-header">
            <h3 id="estimator-item-modal-title">{editingItemId ? "Edit Item" : "New Item"}</h3>
            <button className="btn btn-icon btn-ghost" onClick={closeItemModal} aria-label="Close item dialog">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: "16px", height: "16px" }}>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="modal-body" style={{ padding: "var(--space-4)" }}>
            <div className="form-group">
              <label htmlFor="est-item-desc">Description</label>
              <input
                ref={modalDescRef}
                id="est-item-desc"
                className="input"
                value={modalDesc}
                disabled={saving}
                onChange={(e) => onDescInput(e.target.value)}
                placeholder="Type to search the Standard Catalog or enter custom…"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={descSuggestions.length > 0}
                aria-controls="est-item-suggestions"
                aria-activedescendant={activeSuggestion >= 0 ? `est-suggestion-${descSuggestions[activeSuggestion]?.id}` : undefined}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && descSuggestions.length) {
                    e.preventDefault()
                    setActiveSuggestion((current) => Math.min(current + 1, descSuggestions.length - 1))
                  } else if (e.key === "ArrowUp" && descSuggestions.length) {
                    e.preventDefault()
                    setActiveSuggestion((current) => Math.max(current - 1, 0))
                  } else if (e.key === "Enter" && activeSuggestion >= 0 && descSuggestions[activeSuggestion]) {
                    e.preventDefault()
                    pickDescSuggestion(descSuggestions[activeSuggestion])
                  } else if (e.key === "Enter") {
                    e.preventDefault()
                    saveItemModal()
                  } else if (e.key === "Escape" && descSuggestions.length) {
                    e.stopPropagation()
                    setDescSuggestions([])
                    setActiveSuggestion(-1)
                  }
                }}
              />
              {descSuggestions.length > 0 && (
                <div id="est-item-suggestions" className="desc-suggest open" role="listbox" aria-label="Standard Catalog suggestions">
                  {descSuggestions.map((h, index) => (
                    <div key={h.id} id={`est-suggestion-${h.id}`} role="option" tabIndex={-1} aria-selected={activeSuggestion === index} className={`ds-item${activeSuggestion === index ? " active" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => pickDescSuggestion(h)}>
                      <div className="ds-title">{h.description}</div>
                      <div className="ds-meta">
                        {h.category || "Catalog item"} · {h.unit} · {h.historicalPricing
                          ? `Approved average ฿${h.historicalPricing.average.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                          : "No approved history · rate starts at ฿0"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {descNotice.kind === "searching" && (
                <div className="desc-suggest open" role="status">
                  <div className="ds-empty">Searching catalog…</div>
                </div>
              )}
              {descNotice.kind === "no-match" && (
                <div className="desc-suggest open">
                  <div className="ds-empty">No catalog match — type your own description</div>
                </div>
              )}
              {descNotice.kind === "selected" && (
                <div className="desc-suggest open">
                  <div className="ds-empty ds-selected">✓ Catalog match — {descNotice.description}</div>
                </div>
              )}
            </div>
            <div className="form-row-2">
              <div className="form-group">
                <label htmlFor="est-item-qty">Quantity</label>
                <input
                  id="est-item-qty"
                  className="input"
                  type="number"
                  value={modalQty}
                  disabled={saving}
                  onChange={(e) => { setModalQty(e.target.value); setItemError("") }}
                  min="0"
                  step="0.5"
                />
              </div>
              <div className="form-group">
                <label htmlFor="est-item-rate">Unit Price (฿)</label>
                <input
                  id="est-item-rate"
                  className="input"
                  type="number"
                  value={modalRate}
                  disabled={saving}
                  onChange={(e) => { setModalRate(e.target.value); setItemError("") }}
                  min="0"
                  step="100"
                />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="est-item-unit">Unit</label>
              <input
                id="est-item-unit"
                className="input"
                value={modalUnit}
                disabled={saving}
                onChange={(e) => setModalUnit(e.target.value)}
                placeholder="e.g. m³, ton, m²"
              />
            </div>
            {itemError && <div className="form-error" role="alert">{itemError}</div>}
            <div className="estimator-modal-actions">
              <button className="btn btn-ghost btn-sm" onClick={closeItemModal}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={saveItemModal} disabled={saving}>
                {editingItemId ? "Save Item" : "Add Item"}
              </button>
            </div>
          </div>
        </div>
      </div>}
    </div>
  )
}
