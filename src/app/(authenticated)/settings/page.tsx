"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { DEFAULT_ESTIMATE_PROMPT, buildPromptSavePayload, promptSettingsAreDirty } from "@/lib/prompt-defaults"
import { addWorkspaceUnit, fetchWorkspaceUnitsOverview, removeWorkspaceUnit, renameWorkspaceUnit, WorkspaceUnitInUseError } from "@/lib/workspace-units-client"
import { STANDARD_UNITS } from "@/lib/units"
import type { DoclingSettings, FuzzySettings, LlmSettings, PromptSettings, Vendor, WorkspaceSettings } from "@/lib/settings-schema"

const LLM_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
] as const
const SPECIALTIES = ["Structural", "MEP", "Finishing", "Full Scope"]
const LLM_TEST_TIMEOUT_MS = 30_000

const DEFAULT_ANALYSIS_PROMPT = `You are a construction cost estimation assistant. Analyse the provided BOQ/quotations data and return structured JSON with the following fields for each item:
- item_code: The item reference code
- description: Item description
- quantity: Quantity from the document
- unit: Unit of measure
- rate: Unit rate in THB
- total: Total amount (qty × rate)
- trend: "below", "at", "above", or "new" compared to historical averages
- analysis: Brief commentary explaining the pricing context, considering both quantity and rate`

const DEFAULT_STD_PROMPT = `You are a construction BOQ standardization assistant. Given a list of raw items and a reference catalog, standardize each item:
1. If the item matches an existing catalog entry (by description + unit), return the catalog entry ID
2. If no match exists, suggest a standardized description and unit following these conventions:
   - Use clear format: "Material — spec/location/dimension"
   - Units: m³, m², m, ton, ea, set, kg, LS
   - Group similar items (e.g. "Reinforcement bar SD40 — 12mm")
3. Do NOT create a duplicate if a matching entry already exists
Return JSON array: [{itemIndex, matchedStdId, suggestedDesc, suggestedUnit, confidence: "high"|"medium"|"low", reason}]`

const DEFAULT_UNIT_MAP = JSON.stringify({ m2: "m²", m3: "m³", sqm: "m²", "sq.m.": "m²", cbm: "m³", "cu.m.": "m³", kg: "kg", kgs: "kg", tonne: "ton", tons: "ton", each: "set", ea: "set", nos: "set", "no.": "set", "lin.m": "m", lm: "m", "r.m": "m" }, null, 2)
const DEFAULT_NORMALIZE_RULES = JSON.stringify([["structural concrete", "concrete"], ["reinforcement bar", "rebar"], ["\\bconc\\.", "concrete"], ["\\d+mm\\b", "$& dia."], ["\\bformwork\\b", "formwork"], ["\\bmobilisation\\b", "mobilization"], ["\\bdemobilisation\\b", "demobilization"], ["\\s+", " "]], null, 2)

type Section = "ai" | "processing" | "vendors" | "prompts" | "account"
type PromptKind = "analysis" | "standardization" | "estimate"
type PromptStatus = { kind: PromptKind; message: string; tone: "status" | "success" | "error" }
type DirtyState = { ai: boolean; docling: boolean; fuzzy: boolean; vendors: boolean; prompts: boolean }
const CLEAN: DirtyState = { ai: false, docling: false, fuzzy: false, vendors: false, prompts: false }

function tokenEstimate(value: string) {
  return Math.round(value.trim().split(/\s+/).filter(Boolean).length * 1.3)
}

function validHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: string }
    return body.error || fallback
  } catch {
    return fallback
  }
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<Section>("ai")
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [settingsLoadError, setSettingsLoadError] = useState("")
  const [dirty, setDirty] = useState<DirtyState>(CLEAN)
  const dirtyRef = useRef(dirty)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const vendorRefreshRef = useRef<{ controller: AbortController | null; sequence: number }>({ controller: null, sequence: 0 })
  const settingsRefreshRef = useRef<{ controller: AbortController | null; sequence: number }>({ controller: null, sequence: 0 })
  const deletingVendorRef = useRef(false)
  const savedAnalysisRef = useRef(DEFAULT_ANALYSIS_PROMPT)
  const savedStdRef = useRef(DEFAULT_STD_PROMPT)
  const savedLlmRef = useRef({ provider: "openai" as LlmSettings["provider"], model: "gpt-4o", endpoint: "" })
  const savedDoclingRef = useRef("http://localhost:5001")
  const savedFuzzyRef = useRef({ unitMap: DEFAULT_UNIT_MAP, normalizeRules: DEFAULT_NORMALIZE_RULES })
  const vendorFormBaselineRef = useRef({ name: "", contact: "", specialty: "Structural" })
  const llmCurrentRef = useRef({ provider: "openai" as LlmSettings["provider"], model: "gpt-4o", endpoint: "" })
  const doclingCurrentRef = useRef("http://localhost:5001")
  const fuzzyCurrentRef = useRef({ unitMap: DEFAULT_UNIT_MAP, normalizeRules: DEFAULT_NORMALIZE_RULES })
  const analysisCurrentRef = useRef(DEFAULT_ANALYSIS_PROMPT)
  const stdCurrentRef = useRef(DEFAULT_STD_PROMPT)
  const estimateCurrentRef = useRef(DEFAULT_ESTIMATE_PROMPT)

  const [llmProvider, setLlmProvider] = useState<LlmSettings["provider"]>("openai")
  const [llmModel, setLlmModel] = useState("gpt-4o")
  const [llmEndpoint, setLlmEndpoint] = useState("")
  const [savingLlm, setSavingLlm] = useState(false)
  const [testingLlm, setTestingLlm] = useState(false)
  const [llmStatus, setLlmStatus] = useState("")
  const llmTestUnavailableReason = llmEndpoint.trim()
    ? "Custom endpoint testing is not supported by the current server runtime."
    : !["openai", "openrouter"].includes(llmProvider)
      ? `${LLM_PROVIDERS.find((provider) => provider.value === llmProvider)?.label || llmProvider} testing is not supported by the current server runtime.`
      : ""

  const [doclingEndpoint, setDoclingEndpoint] = useState("http://localhost:5001")
  const [savingDocling, setSavingDocling] = useState(false)
  const [testingDocling, setTestingDocling] = useState(false)
  const [doclingStatus, setDoclingStatus] = useState("")

  const [unitMap, setUnitMap] = useState(DEFAULT_UNIT_MAP)
  const [normalizeRules, setNormalizeRules] = useState(DEFAULT_NORMALIZE_RULES)
  const [savingFuzzy, setSavingFuzzy] = useState(false)
  const [fuzzyTestResult, setFuzzyTestResult] = useState("")

  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loadingVendors, setLoadingVendors] = useState(true)
  const [vendorDialogOpen, setVendorDialogOpen] = useState(false)
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null)
  const [vendorName, setVendorName] = useState("")
  const [vendorContact, setVendorContact] = useState("")
  const [vendorSpecialty, setVendorSpecialty] = useState("Structural")
  const [savingVendor, setSavingVendor] = useState(false)
  const [deletingVendorId, setDeletingVendorId] = useState<string | null>(null)
  const [deletingVendorBusyId, setDeletingVendorBusyId] = useState<string | null>(null)

  const [analysisPrompt, setAnalysisPrompt] = useState(DEFAULT_ANALYSIS_PROMPT)
  const [stdPrompt, setStdPrompt] = useState(DEFAULT_STD_PROMPT)
  const [estimatePrompt, setEstimatePrompt] = useState(DEFAULT_ESTIMATE_PROMPT)
  const [savedEstimatePrompt, setSavedEstimatePrompt] = useState(DEFAULT_ESTIMATE_PROMPT)
  const [savingAnalysisPrompt, setSavingAnalysisPrompt] = useState(false)
  const [savingStdPrompt, setSavingStdPrompt] = useState(false)
  const [savingEstimatePrompt, setSavingEstimatePrompt] = useState(false)
  const [promptStatus, setPromptStatus] = useState<PromptStatus | null>(null)
  const savedEstimateRef = useRef(DEFAULT_ESTIMATE_PROMPT)

  const [unitsOverview, setUnitsOverview] = useState<{ customUnits: string[]; usage: Record<string, number> }>({ customUnits: [], usage: {} })
  const [unitsLoaded, setUnitsLoaded] = useState(false)
  const [unitAddValue, setUnitAddValue] = useState("")
  const [unitBusy, setUnitBusy] = useState<string | null>(null)
  const [renamingUnit, setRenamingUnit] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<{ unit: string; usageCount: number | null } | null>(null)
  const analysisTokenEstimate = tokenEstimate(analysisPrompt)
  const stdTokenEstimate = tokenEstimate(stdPrompt)
  const estimateTokenEstimate = tokenEstimate(estimatePrompt)
  const settingsReady = !loadingSettings && !settingsLoadError

  const markDirty = (section: keyof DirtyState, value = true) => {
    const next = { ...dirtyRef.current, [section]: value }
    dirtyRef.current = next
    setDirty(next)
  }

  const fetchVendors = useCallback(async () => {
    if (!mountedRef.current) return
    vendorRefreshRef.current.controller?.abort()
    const controller = new AbortController()
    const sequence = vendorRefreshRef.current.sequence + 1
    vendorRefreshRef.current = { controller, sequence }
    setLoadingVendors(true)
    try {
      const response = await fetch("/api/vendors", { signal: controller.signal })
      if (!response.ok) throw new Error(await responseError(response, "Failed to fetch vendors"))
      const data = await response.json() as Vendor[]
      if (mountedRef.current && vendorRefreshRef.current.sequence === sequence) setVendors(data)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      toast.error(error instanceof Error ? error.message : "Failed to load vendors")
    } finally {
      if (mountedRef.current && vendorRefreshRef.current.sequence === sequence) setLoadingVendors(false)
    }
  }, [])

  const fetchSettings = useCallback(async () => {
    if (!mountedRef.current) return
    settingsRefreshRef.current.controller?.abort()
    const controller = new AbortController()
    const sequence = settingsRefreshRef.current.sequence + 1
    settingsRefreshRef.current = { controller, sequence }
    setLoadingSettings(true)
    setSettingsLoadError("")
    try {
      const response = await fetch("/api/settings", { signal: controller.signal })
      if (!response.ok) throw new Error(await responseError(response, "Failed to fetch settings"))
      const data = await response.json() as WorkspaceSettings
      if (!mountedRef.current || settingsRefreshRef.current.sequence !== sequence) return
      if (!dirtyRef.current.ai && data.llm) {
        const nextLlm = { provider: data.llm.provider, model: data.llm.model || "gpt-4o", endpoint: data.llm.endpoint || "" }
        setLlmProvider(nextLlm.provider); setLlmModel(nextLlm.model); setLlmEndpoint(nextLlm.endpoint)
        llmCurrentRef.current = nextLlm; savedLlmRef.current = nextLlm
      }
      if (!dirtyRef.current.docling && data.docling) {
        const endpoint = data.docling.endpoint || "http://localhost:5001"
        setDoclingEndpoint(endpoint); doclingCurrentRef.current = endpoint; savedDoclingRef.current = endpoint
      }
      if (!dirtyRef.current.fuzzy && data.fuzzy) {
        const nextUnitMap = JSON.stringify(data.fuzzy.unitMap, null, 2)
        const nextNormalizeRules = JSON.stringify(data.fuzzy.normalizeRules, null, 2)
        setUnitMap(nextUnitMap); setNormalizeRules(nextNormalizeRules)
        fuzzyCurrentRef.current = { unitMap: nextUnitMap, normalizeRules: nextNormalizeRules }
        savedFuzzyRef.current = { unitMap: nextUnitMap, normalizeRules: nextNormalizeRules }
      }
      if (!dirtyRef.current.prompts && data.prompts) {
        const analysis = data.prompts.analysisPrompt || DEFAULT_ANALYSIS_PROMPT
        const standardization = data.prompts.stdPrompt || DEFAULT_STD_PROMPT
        const estimate = data.prompts.estimatePrompt || DEFAULT_ESTIMATE_PROMPT
        setAnalysisPrompt(analysis); setStdPrompt(standardization); setEstimatePrompt(estimate); setSavedEstimatePrompt(estimate)
        analysisCurrentRef.current = analysis; stdCurrentRef.current = standardization; estimateCurrentRef.current = estimate
        savedAnalysisRef.current = analysis; savedStdRef.current = standardization; savedEstimateRef.current = estimate
        setPromptStatus(null)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      const message = error instanceof Error ? error.message : "Failed to load settings"
      if (mountedRef.current && settingsRefreshRef.current.sequence === sequence) {
        setSettingsLoadError(message)
        toast.error(message)
      }
    } finally {
      if (mountedRef.current && settingsRefreshRef.current.sequence === sequence) setLoadingSettings(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void Promise.resolve().then(() => fetchSettings())
    void Promise.resolve().then(() => fetchVendors())
    void fetchWorkspaceUnitsOverview()
      .then((o) => { if (mountedRef.current) setUnitsOverview({ customUnits: o.customUnits, usage: o.usage }) })
      .catch(() => { if (mountedRef.current) toast.error("Could not load workspace units") })
      .finally(() => { if (mountedRef.current) setUnitsLoaded(true) })
    return () => {
      mountedRef.current = false
      settingsRefreshRef.current.controller?.abort()
      vendorRefreshRef.current.controller?.abort()
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    }
  }, [fetchSettings, fetchVendors])

  useEffect(() => {
    const warnAboutUnsavedPrompts = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current.prompts) return
      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", warnAboutUnsavedPrompts)
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedPrompts)
  }, [])

  const saveSection = async (section: "llm" | "docling" | "fuzzy" | "prompts", data: LlmSettings | DoclingSettings | FuzzySettings | PromptSettings) => {
    if (!settingsReady) throw new Error("Reload workspace settings before making changes")
    const response = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section, data }) })
    if (!response.ok) throw new Error(await responseError(response, `Failed to save ${section} settings`))
  }

  const handleSaveLlm = async () => {
    if (!llmModel.trim()) return toast.error("Model is required")
    if (llmEndpoint.trim() && !validHttpUrl(llmEndpoint.trim())) return toast.error("Custom endpoint must be a valid HTTP or HTTPS URL")
    const snapshot = { provider: llmProvider, model: llmModel.trim(), endpoint: llmEndpoint.trim() }
    setSavingLlm(true)
    try {
      await saveSection("llm", { provider: snapshot.provider, model: snapshot.model, ...(snapshot.endpoint ? { endpoint: snapshot.endpoint } : {}) })
      savedLlmRef.current = snapshot
      const current = llmCurrentRef.current
      markDirty("ai", current.provider !== snapshot.provider || current.model.trim() !== snapshot.model || current.endpoint.trim() !== snapshot.endpoint)
      toast.success("LLM settings saved")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to save LLM settings") }
    finally { setSavingLlm(false) }
  }

  const handleTestLlm = async () => {
    if (llmTestUnavailableReason) {
      setLlmStatus(llmTestUnavailableReason)
      return
    }
    setTestingLlm(true); setLlmStatus("Testing connection…")
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), LLM_TEST_TIMEOUT_MS)
    try {
      const response = await fetch("/api/llm/connection", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ provider: llmProvider, model: llmModel }) })
      if (!response.ok) throw new Error(await responseError(response, "LLM connection failed"))
      const data = await response.json() as { provider?: string; model?: string }
      setLlmStatus(`Connected${data.provider ? ` · ${data.provider} ${data.model || ""}` : ""}`); toast.success("LLM connection successful")
    } catch (error) {
      const message = error instanceof DOMException && error.name === "AbortError" ? "LLM connection timed out" : error instanceof Error ? error.message : "LLM connection failed"
      setLlmStatus(message); toast.error(message)
    } finally { clearTimeout(timeout); setTestingLlm(false) }
  }

  const handleSaveDocling = async () => {
    if (!doclingEndpoint.trim()) return toast.error("Docling sidecar URL is required")
    if (!validHttpUrl(doclingEndpoint.trim())) return toast.error("Docling sidecar URL must use HTTP or HTTPS")
    const snapshot = doclingEndpoint.trim()
    setSavingDocling(true)
    try { await saveSection("docling", { endpoint: snapshot }); savedDoclingRef.current = snapshot; markDirty("docling", doclingCurrentRef.current.trim() !== snapshot); toast.success("Docling settings saved") }
    catch (error) { toast.error(error instanceof Error ? error.message : "Failed to save Docling settings") }
    finally { setSavingDocling(false) }
  }

  const handleTestDocling = async () => {
    setTestingDocling(true); setDoclingStatus("Testing connection…")
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch("/api/docling/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ endpoint: doclingEndpoint.trim() }),
      })
      if (!response.ok) throw new Error(await responseError(response, `Sidecar returned ${response.status}`))
      setDoclingStatus("Connected"); toast.success("Docling sidecar is reachable")
    } catch (error) {
      const message = error instanceof DOMException && error.name === "AbortError" ? "Connection timed out" : error instanceof Error ? error.message : "Docling sidecar not reachable"
      setDoclingStatus(message); toast.error(message)
    } finally { clearTimeout(timeout); setTestingDocling(false) }
  }

  const parseFuzzyRules = () => {
    const parsedUnitMap = JSON.parse(unitMap) as unknown
    const parsedNormalizeRules = JSON.parse(normalizeRules) as unknown
    if (!parsedUnitMap || Array.isArray(parsedUnitMap) || typeof parsedUnitMap !== "object") throw new Error("Unit map must be a JSON object")
    if (!Array.isArray(parsedNormalizeRules) || !parsedNormalizeRules.every((rule) => Array.isArray(rule) && rule.length === 2 && rule.every((part) => typeof part === "string"))) throw new Error("Normalisation rules must be [find, replace] string pairs")
    return { unitMap: parsedUnitMap as Record<string, string>, normalizeRules: parsedNormalizeRules as [string, string][] }
  }

  const handleSaveFuzzy = async () => {
    let data: FuzzySettings
    try { data = parseFuzzyRules() } catch (error) { toast.error(`Invalid JSON — ${error instanceof Error ? error.message : "unknown error"}`); return }
    const snapshot = { unitMap, normalizeRules }
    setSavingFuzzy(true)
    try {
      await saveSection("fuzzy", data)
      savedFuzzyRef.current = snapshot
      const current = fuzzyCurrentRef.current
      markDirty("fuzzy", current.unitMap !== snapshot.unitMap || current.normalizeRules !== snapshot.normalizeRules)
      toast.success("Fuzzy matching rules saved")
    }
    catch (error) { toast.error(error instanceof Error ? error.message : "Failed to save fuzzy matching rules") }
    finally { setSavingFuzzy(false) }
  }

  const handleTestFuzzy = () => {
    let data: FuzzySettings
    try { data = parseFuzzyRules() } catch (error) { toast.error(`Invalid JSON — ${error instanceof Error ? error.message : "unknown error"}`); return }
    const sample = window.prompt("Enter a description to test matching:", "Structural concrete C32/40 (columns)")
    if (!sample) return
    try {
      const normalized = data.normalizeRules.reduce((value, [find, replacement]) => value.replace(new RegExp(find, "gi"), replacement), sample.toLowerCase()).replace(/\s+/g, " ").trim()
      setFuzzyTestResult(`Normalised: “${normalized}”`)
    } catch (error) { toast.error(`Invalid matching rule — ${error instanceof Error ? error.message : "unknown error"}`) }
  }

  const openAddVendor = () => { const baseline = { name: "", contact: "", specialty: "Structural" }; vendorFormBaselineRef.current = baseline; setEditingVendor(null); setVendorName(baseline.name); setVendorContact(baseline.contact); setVendorSpecialty(baseline.specialty); markDirty("vendors", false); setVendorDialogOpen(true) }
  const openEditVendor = (vendor: Vendor) => { const baseline = { name: vendor.name, contact: vendor.contact, specialty: vendor.specialty }; vendorFormBaselineRef.current = baseline; setEditingVendor(vendor); setVendorName(baseline.name); setVendorContact(baseline.contact); setVendorSpecialty(baseline.specialty); markDirty("vendors", false); setVendorDialogOpen(true) }
  const closeVendorDialog = () => {
    if (!savingVendor) {
      setVendorDialogOpen(false)
      markDirty("vendors", false)
    }
  }

  const handleSaveVendor = async () => {
    if (!vendorName.trim()) return toast.error("Vendor name is required")
    setSavingVendor(true)
    try {
      const response = await fetch(editingVendor ? `/api/vendors/${editingVendor.id}` : "/api/vendors", { method: editingVendor ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: vendorName.trim(), contact: vendorContact.trim(), specialty: vendorSpecialty }) })
      if (!response.ok) throw new Error(await responseError(response, editingVendor ? "Failed to update vendor" : "Failed to add vendor"))
      if (mountedRef.current) { setVendorDialogOpen(false); markDirty("vendors", false); toast.success(editingVendor ? "Vendor updated" : "Vendor added") }
      await fetchVendors()
    } catch (error) { if (mountedRef.current) toast.error(error instanceof Error ? error.message : editingVendor ? "Failed to update vendor" : "Failed to add vendor") }
    finally { if (mountedRef.current) setSavingVendor(false) }
  }

  const handleDeleteVendor = async (vendor: Vendor) => {
    if (deletingVendorRef.current || savingVendor) return
    if (deletingVendorId !== vendor.id) {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      setDeletingVendorId(vendor.id); toast.error(`Click again to confirm removal of ${vendor.name}`)
      deleteTimerRef.current = setTimeout(() => { setDeletingVendorId(null); deleteTimerRef.current = null }, 4000)
      return
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    deleteTimerRef.current = null
    deletingVendorRef.current = true
    setDeletingVendorId(null)
    setDeletingVendorBusyId(vendor.id)
    try {
      const response = await fetch(`/api/vendors/${vendor.id}`, { method: "DELETE" })
      if (!response.ok) throw new Error(await responseError(response, "Failed to delete vendor"))
      if (mountedRef.current) toast.success(`Removed ${vendor.name}`)
      await fetchVendors()
    } catch (error) { if (mountedRef.current) toast.error(error instanceof Error ? error.message : "Failed to delete vendor") }
    finally {
      deletingVendorRef.current = false
      if (mountedRef.current) setDeletingVendorBusyId(null)
    }
  }

  const handleAddUnit = async () => {
    const value = unitAddValue.trim()
    if (!value) return
    setUnitBusy("__add__")
    try {
      const result = await addWorkspaceUnit(value)
      setUnitsOverview((prev) => ({ customUnits: result.customUnits, usage: prev.usage }))
      setUnitAddValue("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add unit.")
    } finally {
      setUnitBusy(null)
    }
  }

  const startRename = (unit: string) => {
    setRenamingUnit(unit); setRenameValue(unit)
  }

  const handleRenameUnit = async (oldUnit: string) => {
    setUnitBusy(oldUnit)
    try {
      const result = await renameWorkspaceUnit(oldUnit, renameValue)
      setUnitsOverview((prev) => ({ customUnits: result.customUnits, usage: prev.usage }))
      setRenamingUnit(null)
      toast.success(`Renamed; updated ${result.updatedItems} item${result.updatedItems === 1 ? "" : "s"}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename unit.")
    } finally {
      setUnitBusy(null)
    }
  }

  const handleConfirmDelete = async () => {
    const target = deleteTarget
    if (!target) return
    setUnitBusy(target.unit)
    try {
      const result = await removeWorkspaceUnit(target.unit)
      setUnitsOverview((prev) => ({ customUnits: result.customUnits, usage: prev.usage }))
      setDeleteTarget(null)
    } catch (error) {
      if (error instanceof WorkspaceUnitInUseError) {
        setDeleteTarget({ unit: target.unit, usageCount: error.usageCount })
      } else {
        toast.error(error instanceof Error ? error.message : "Could not delete unit.")
      }
    } finally {
      setUnitBusy(null)
    }
  }

  const currentPromptSettings = (): PromptSettings => ({
    analysisPrompt: analysisCurrentRef.current,
    stdPrompt: stdCurrentRef.current,
    estimatePrompt: estimateCurrentRef.current,
  })

  const savedPromptSettings = (): PromptSettings => ({
    analysisPrompt: savedAnalysisRef.current,
    stdPrompt: savedStdRef.current,
    estimatePrompt: savedEstimateRef.current,
  })

  const savePrompt = async (kind: PromptKind) => {
    const field: keyof PromptSettings = kind === "analysis" ? "analysisPrompt" : kind === "standardization" ? "stdPrompt" : "estimatePrompt"
    const label = kind === "analysis" ? "Analysis" : kind === "standardization" ? "Standardization" : "Estimate Builder AI"
    const current = currentPromptSettings()
    const value = current[field]
    if (!value.trim()) return toast.error(`${label} prompt cannot be empty`)
    if (value.length > 20_000) return toast.error("Prompt cannot exceed 20000 characters")
    const setSaving = kind === "analysis" ? setSavingAnalysisPrompt : kind === "standardization" ? setSavingStdPrompt : setSavingEstimatePrompt
    const data = buildPromptSavePayload(savedPromptSettings(), current, field)
    setSaving(true)
    setPromptStatus({ kind, message: "Saving…", tone: "status" })
    try {
      await saveSection("prompts", data)
      if (field === "analysisPrompt") savedAnalysisRef.current = value
      if (field === "stdPrompt") savedStdRef.current = value
      if (field === "estimatePrompt") {
        savedEstimateRef.current = value
        setSavedEstimatePrompt(value)
      }
      markDirty("prompts", promptSettingsAreDirty(currentPromptSettings(), savedPromptSettings()))
      setPromptStatus({ kind, message: `${label} prompt saved`, tone: "success" })
      toast.success(`${label} prompt saved`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save prompt"
      setPromptStatus({ kind, message, tone: "error" })
      toast.error(message)
    }
    finally { setSaving(false) }
  }

  const navigateTo = (section: Section) => {
    setActiveSection(section)
    document.getElementById(`settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const updateAnalysisPrompt = (value: string) => {
    setAnalysisPrompt(value); analysisCurrentRef.current = value
    setPromptStatus((status) => status?.kind === "analysis" ? null : status)
    markDirty("prompts", promptSettingsAreDirty(currentPromptSettings(), savedPromptSettings()))
  }
  const updateStdPrompt = (value: string) => {
    setStdPrompt(value); stdCurrentRef.current = value
    setPromptStatus((status) => status?.kind === "standardization" ? null : status)
    markDirty("prompts", promptSettingsAreDirty(currentPromptSettings(), savedPromptSettings()))
  }
  const updateEstimatePrompt = (value: string) => {
    setEstimatePrompt(value); estimateCurrentRef.current = value
    setPromptStatus((status) => status?.kind === "estimate" ? null : status)
    markDirty("prompts", promptSettingsAreDirty(currentPromptSettings(), savedPromptSettings()))
  }
  const updateVendorDraft = (next: { name: string; contact: string; specialty: string }) => {
    setVendorName(next.name); setVendorContact(next.contact); setVendorSpecialty(next.specialty)
    markDirty("vendors", JSON.stringify(next) !== JSON.stringify(vendorFormBaselineRef.current))
  }

  const navItems: { id: Section; label: string; dirtyKey?: keyof DirtyState }[] = [
    { id: "ai", label: "AI & models", dirtyKey: "ai" }, { id: "processing", label: "Document processing" }, { id: "vendors", label: "Vendors", dirtyKey: "vendors" }, { id: "prompts", label: "Prompts", dirtyKey: "prompts" }, { id: "account", label: "Account" },
  ]

  return (
    <div className="settings-grid" data-od-id="settings-page" aria-busy={loadingSettings}>
      <nav className="settings-nav" aria-label="Settings sections">
        <p className="settings-nav-label">Workspace settings</p>
        {navItems.map((item) => {
          const itemIsDirty = item.id === "processing" ? dirty.docling || dirty.fuzzy : item.dirtyKey ? dirty[item.dirtyKey] : false
          return <button key={item.id} type="button" className={activeSection === item.id ? "active" : ""} aria-current={activeSection === item.id ? "location" : undefined} onClick={() => navigateTo(item.id)}>{item.label}{itemIsDirty && <span className="settings-unsaved" aria-label="Unsaved changes">Unsaved</span>}</button>
        })}
      </nav>

      <div className="settings-content">
        {loadingSettings && <div className="settings-loading" role="status"><Loader2 className="proto-spinner" aria-hidden="true" /> Loading workspace settings…</div>}
        {!loadingSettings && settingsLoadError && <div className="settings-load-error" role="alert"><div><strong>Workspace settings unavailable</strong><p>The values below are examples only and cannot be changed until persisted settings load successfully.</p></div><button type="button" className="btn btn-secondary btn-sm" onClick={() => void fetchSettings()}>Retry</button></div>}

        <section id="settings-ai" className={`proto-card settings-section${settingsReady ? "" : " settings-configuration-locked"}`} data-od-id="llm-settings" inert={!settingsReady ? true : undefined}>
          <header className="settings-section-header"><div><h2>LLM provider</h2><p>Configure the model used for verification, comparisons, and suggestions.</p></div>{dirty.ai && <span className="settings-dirty">Unsaved changes</span>}</header>
          <div className="settings-section-body settings-form-grid">
            <div className="proto-field"><label htmlFor="llm-provider">Provider</label><select id="llm-provider" className="proto-select" value={llmProvider} onChange={(event) => { const provider = event.target.value as LlmSettings["provider"]; const next = { ...llmCurrentRef.current, provider }; setLlmProvider(provider); llmCurrentRef.current = next; markDirty("ai", JSON.stringify(next) !== JSON.stringify(savedLlmRef.current)) }}>{LLM_PROVIDERS.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></div>
            <div className="proto-field"><label htmlFor="llm-model">Model</label><input id="llm-model" className="proto-input" maxLength={200} value={llmModel} onChange={(event) => { const model = event.target.value; const next = { ...llmCurrentRef.current, model }; setLlmModel(model); llmCurrentRef.current = next; markDirty("ai", JSON.stringify(next) !== JSON.stringify(savedLlmRef.current)) }} placeholder="e.g. gpt-4o" /></div>
            <div className="proto-field settings-field-wide"><label htmlFor="llm-endpoint">Custom endpoint <span className="meta">(optional)</span></label><input id="llm-endpoint" className="proto-input" type="url" maxLength={2048} value={llmEndpoint} onChange={(event) => { const endpoint = event.target.value; const next = { ...llmCurrentRef.current, endpoint }; setLlmEndpoint(endpoint); llmCurrentRef.current = next; markDirty("ai", JSON.stringify(next) !== JSON.stringify(savedLlmRef.current)) }} placeholder="https://api.openai.com/v1" /><p className="settings-help">The current server runtime can test OpenAI and OpenRouter with their default endpoints. Custom endpoint testing is not supported.</p></div>
            <div className="proto-field settings-field-wide"><label htmlFor="llm-api-key">API key</label><input id="llm-api-key" className="proto-input" type="password" value="server-environment" readOnly aria-readonly="true" /><p className="settings-help">API keys are read-only here and must be configured securely in the server environment.</p></div>
            <div className="settings-actions settings-field-wide"><button className="btn btn-primary btn-sm" onClick={handleSaveLlm} disabled={savingLlm}>{savingLlm && <Loader2 className="proto-spinner" aria-hidden="true" />}Save changes</button><button className="btn btn-secondary btn-sm" onClick={handleTestLlm} disabled={testingLlm || Boolean(llmTestUnavailableReason)} title={llmTestUnavailableReason || undefined}>{testingLlm && <Loader2 className="proto-spinner" aria-hidden="true" />}Test connection</button><span className="settings-inline-status" role="status" aria-live="polite">{llmStatus || llmTestUnavailableReason}</span></div>
          </div>
        </section>

        <section id="settings-processing" className={`settings-section-group${settingsReady ? "" : " settings-configuration-locked"}`} inert={!settingsReady ? true : undefined}>
          <article className="proto-card settings-section" data-od-id="docling-settings"><header className="settings-section-header"><div><h2>Docling sidecar</h2><p>PDF parsing service used during BOQ upload.</p></div>{dirty.docling && <span className="settings-dirty">Unsaved changes</span>}</header><div className="settings-section-body"><div className="proto-field"><label htmlFor="docling-endpoint">Sidecar URL</label><input id="docling-endpoint" className="proto-input" type="url" maxLength={2048} value={doclingEndpoint} onChange={(event) => { const endpoint = event.target.value; setDoclingEndpoint(endpoint); doclingCurrentRef.current = endpoint; markDirty("docling", endpoint !== savedDoclingRef.current) }} placeholder="http://localhost:5001" /><p className="settings-help">FastAPI server running Docling for PDF parsing.</p></div><div className="settings-actions"><button className="btn btn-primary btn-sm" onClick={handleSaveDocling} disabled={savingDocling}>{savingDocling && <Loader2 className="proto-spinner" aria-hidden="true" />}Save endpoint</button><button className="btn btn-secondary btn-sm" onClick={handleTestDocling} disabled={testingDocling}>{testingDocling && <Loader2 className="proto-spinner" aria-hidden="true" />}Test connection</button><span className="settings-inline-status" role="status" aria-live="polite">{doclingStatus}</span></div></div></article>
          <article className="proto-card settings-section" data-od-id="fuzzy-rules-settings"><header className="settings-section-header"><div><h2>Catalog fuzzy rules</h2><p>Rules applied when incoming BOQ items are matched to the standard catalog.</p></div>{dirty.fuzzy && <span className="settings-dirty">Unsaved changes</span>}</header><div className="settings-section-body"><div className="proto-field"><label htmlFor="fuzzy-unit-map">Unit equivalence map <span className="meta">(JSON object)</span></label><textarea id="fuzzy-unit-map" className="proto-textarea settings-code" rows={7} value={unitMap} onChange={(event) => { const nextUnitMap = event.target.value; const next = { ...fuzzyCurrentRef.current, unitMap: nextUnitMap }; setUnitMap(nextUnitMap); fuzzyCurrentRef.current = next; markDirty("fuzzy", JSON.stringify(next) !== JSON.stringify(savedFuzzyRef.current)) }} /></div><div className="proto-field"><label htmlFor="fuzzy-normalize-rules">Description normalisation rules <span className="meta">([find, replace] pairs)</span></label><textarea id="fuzzy-normalize-rules" className="proto-textarea settings-code" rows={7} value={normalizeRules} onChange={(event) => { const nextNormalizeRules = event.target.value; const next = { ...fuzzyCurrentRef.current, normalizeRules: nextNormalizeRules }; setNormalizeRules(nextNormalizeRules); fuzzyCurrentRef.current = next; markDirty("fuzzy", JSON.stringify(next) !== JSON.stringify(savedFuzzyRef.current)) }} /></div><div className="settings-actions"><button className="btn btn-primary btn-sm" onClick={handleSaveFuzzy} disabled={savingFuzzy}>{savingFuzzy && <Loader2 className="proto-spinner" aria-hidden="true" />}Save rules</button><button className="btn btn-secondary btn-sm" onClick={handleTestFuzzy}>Test match</button><span className="settings-inline-status" role="status" aria-live="polite">{fuzzyTestResult}</span></div></div></article>
        </section>

        <article className="proto-card settings-section" data-od-id="workspace-units-settings" id="units"><header className="settings-section-header"><div><h2>Workspace units</h2><p>Standard units are fixed. Custom units can be renamed (updates all BOQ items) or deleted when not in use.</p></div></header><div className="settings-section-body"><div className="proto-field"><label htmlFor="units-add-input">Add custom unit</label><div className="settings-actions"><input id="units-add-input" className="proto-input" data-od-id="units-add-input" value={unitAddValue} onChange={(e) => setUnitAddValue(e.target.value)} placeholder="e.g. pallet" maxLength={24} /><button className="btn btn-primary btn-sm" data-od-id="units-add-button" onClick={() => void handleAddUnit()} disabled={unitBusy === "__add__" || unitAddValue.trim() === ""}>Add unit</button></div></div><div className="proto-field"><span className="settings-label">Standard units</span><ul className="unit-chips">{STANDARD_UNITS.map((u) => <li key={u} className="unit-chip unit-chip-standard">{u}</li>)}</ul></div><div className="proto-field"><span className="settings-label">Custom units</span>{!unitsLoaded ? <p className="meta">Loading…</p> : unitsOverview.customUnits.length === 0 ? <p className="meta">No custom units yet.</p> : <ul className="unit-rows">{unitsOverview.customUnits.map((unit) => { const usage = unitsOverview.usage[unit] ?? 0; return <li key={unit} className="unit-row">{renamingUnit === unit ? <><input className="proto-input" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={24} aria-label={`Rename ${unit}`} /><button className="btn btn-primary btn-sm" onClick={() => void handleRenameUnit(unit)} disabled={unitBusy === unit}>Save</button><button className="btn btn-secondary btn-sm" onClick={() => setRenamingUnit(null)}>Cancel</button></> : <><span className="unit-row-value">{unit}</span><span className="unit-row-usage">{usage} item{usage === 1 ? "" : "s"}</span><button className="btn btn-secondary btn-sm" data-od-id={`units-rename-${unit}`} onClick={() => startRename(unit)} disabled={unitBusy === unit}>Rename</button><button className="btn btn-outline-danger btn-sm" data-od-id={`units-delete-${unit}`} onClick={() => setDeleteTarget({ unit, usageCount: null })} disabled={unitBusy === unit}>Delete</button></>}</li> })}</ul>}</div></div></article>

        <section id="settings-vendors" className="proto-card settings-section" data-od-id="vendor-settings"><header className="settings-section-header"><div><h2>Vendors</h2><p>Maintain contractor contacts used across BOQs and estimates.</p></div><button className="btn btn-primary btn-sm" onClick={openAddVendor} disabled={savingVendor || deletingVendorBusyId !== null}><Plus aria-hidden="true" />Add vendor</button></header><div className="settings-table-wrap" tabIndex={0} aria-label="Vendors table, horizontally scrollable"><table className="data-table"><thead><tr><th>Vendor name</th><th>Specialty</th><th className="num-col">Linked BOQs</th><th>Last used</th><th>Actions</th></tr></thead><tbody>{loadingVendors ? <tr><td colSpan={5}><div className="settings-row-status" role="status"><Loader2 className="proto-spinner" aria-hidden="true" />Loading vendors…</div></td></tr> : vendors.length === 0 ? <tr><td colSpan={5}><div className="settings-row-status">No vendors yet. Add one to begin.</div></td></tr> : vendors.map((vendor) => <tr key={vendor.id}><td><strong>{vendor.name}</strong>{vendor.contact && <span className="meta settings-vendor-contact">{vendor.contact}</span>}</td><td>{vendor.specialty}</td><td className="num-col">{vendor.linkedBoqCount}</td><td>{vendor.lastUsed ? new Date(vendor.lastUsed).toLocaleDateString() : "—"}</td><td><div className="settings-row-actions"><button className="btn btn-ghost btn-sm" disabled={savingVendor || deletingVendorBusyId !== null} onClick={() => openEditVendor(vendor)} aria-label={`Edit ${vendor.name}`}><Pencil aria-hidden="true" />Edit</button><button className="btn btn-outline-danger btn-sm" disabled={savingVendor || deletingVendorBusyId !== null} onClick={() => void handleDeleteVendor(vendor)} aria-label={`${deletingVendorId === vendor.id ? "Confirm removal of" : "Remove"} ${vendor.name}`}><Trash2 aria-hidden="true" />{deletingVendorBusyId === vendor.id ? "Removing…" : deletingVendorId === vendor.id ? "Confirm" : "Remove"}</button></div></td></tr>)}</tbody></table></div><p className="settings-table-note">Renaming a vendor updates the name across all linked BOQs and historical data.</p></section>

        <section id="settings-prompts" role="group" aria-label="Prompt settings" className={`settings-section-group${settingsReady ? "" : " settings-configuration-locked"}`} aria-disabled={!settingsReady} inert={!settingsReady ? true : undefined}>
          <article className="proto-card settings-section" data-od-id="llm-prompt-settings">
            <header className="settings-section-header"><div><h2>LLM analysis prompt</h2><p>Controls how pricing is evaluated across analysis features.</p></div><span className="meta">~{analysisTokenEstimate} tokens</span></header>
            <div className="settings-section-body"><div className="proto-field"><label htmlFor="analysis-prompt">System prompt</label><textarea id="analysis-prompt" className="proto-textarea settings-prompt" maxLength={20000} value={analysisPrompt} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt} onChange={(event) => updateAnalysisPrompt(event.target.value)} /></div><div className="settings-actions"><button className="btn btn-primary btn-sm" onClick={() => void savePrompt("analysis")} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt}>{savingAnalysisPrompt && <Loader2 className="proto-spinner" aria-hidden="true" />}Save analysis prompt</button><button className="btn btn-ghost btn-sm" onClick={() => updateAnalysisPrompt(DEFAULT_ANALYSIS_PROMPT)} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt}>Reset to default</button>{promptStatus?.kind === "analysis" && <span className="settings-inline-status" role={promptStatus.tone === "error" ? "alert" : "status"} aria-live="polite">{promptStatus.message}</span>}</div></div>
          </article>
          <article className="proto-card settings-section" data-od-id="standardization-prompt-settings">
            <header className="settings-section-header"><div><h2>Standardization prompt</h2><p>Used during Pass 3 for unmatched-item suggestions.</p></div><span className="meta">~{stdTokenEstimate} tokens</span></header>
            <div className="settings-section-body"><div className="proto-field"><label htmlFor="standardization-prompt">System prompt</label><textarea id="standardization-prompt" className="proto-textarea settings-prompt settings-code" maxLength={20000} value={stdPrompt} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt} onChange={(event) => updateStdPrompt(event.target.value)} /></div><div className="settings-actions"><button className="btn btn-primary btn-sm" onClick={() => void savePrompt("standardization")} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt}>{savingStdPrompt && <Loader2 className="proto-spinner" aria-hidden="true" />}Save standardization prompt</button><button className="btn btn-ghost btn-sm" onClick={() => updateStdPrompt(DEFAULT_STD_PROMPT)} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt}>Reset to default</button>{promptStatus?.kind === "standardization" && <span className="settings-inline-status" role={promptStatus.tone === "error" ? "alert" : "status"} aria-live="polite">{promptStatus.message}</span>}</div></div>
          </article>
          <article className="proto-card settings-section" data-od-id="estimate-prompt-settings">
            <header className="settings-section-header"><div><h2>Estimate Builder AI prompt</h2><p>This prompt guides AI chat when users build estimates from scratch.</p></div><div className="settings-section-header-meta">{estimatePrompt !== savedEstimatePrompt && <span className="settings-dirty">Unsaved changes</span>}<span className="meta">~{estimateTokenEstimate} tokens</span></div></header>
            <div className="settings-section-body"><div className="proto-field"><label htmlFor="estimate-builder-prompt">Prompt text</label><textarea id="estimate-builder-prompt" className="proto-textarea settings-prompt settings-code" maxLength={20000} value={estimatePrompt} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt} aria-describedby="estimate-builder-prompt-help" data-od-id="estimate-builder-prompt" onChange={(event) => updateEstimatePrompt(event.target.value)} /><p id="estimate-builder-prompt-help" className="settings-help">Use this to shape the questions, catalog suggestions, and JSON response returned by the estimate builder chat.</p></div><div className="settings-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => void savePrompt("estimate")} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt} data-od-id="save-estimate-builder-prompt">{savingEstimatePrompt && <Loader2 className="proto-spinner" aria-hidden="true" />}Save Estimate Builder prompt</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => updateEstimatePrompt(DEFAULT_ESTIMATE_PROMPT)} disabled={savingAnalysisPrompt || savingStdPrompt || savingEstimatePrompt} data-od-id="reset-estimate-builder-prompt">Reset to default</button>{promptStatus?.kind === "estimate" && <span className="settings-inline-status" role={promptStatus.tone === "error" ? "alert" : "status"} aria-live="polite">{promptStatus.message}</span>}</div></div>
          </article>
        </section>

        <section id="settings-account" className="proto-card settings-section" data-od-id="account-settings"><header className="settings-section-header"><div><h2>Account</h2><p>Identity values are managed by authentication configuration.</p></div></header><div className="settings-section-body settings-form-grid"><div className="proto-field"><label htmlFor="account-name">Name</label><input id="account-name" className="proto-input" value="Construction Consultant" readOnly /></div><div className="proto-field"><label htmlFor="account-email">Email</label><input id="account-email" className="proto-input" type="email" value="admin@buildestimate.app" readOnly /></div><div className="settings-field-wide"><button className="btn btn-secondary btn-sm" type="button" disabled>Change password</button><p className="settings-help">Password changes are not available in this prototype. Update authentication credentials in the server environment.</p></div></div></section>
      </div>

      <Dialog open={vendorDialogOpen} onOpenChange={(open) => { if (!open) closeVendorDialog(); else setVendorDialogOpen(true) }}><DialogContent className="settings-vendor-modal" data-od-id="add-vendor-modal" aria-busy={savingVendor}><DialogHeader><DialogTitle>{editingVendor ? "Edit vendor" : "Add vendor"}</DialogTitle></DialogHeader><div className="settings-modal-fields"><div className="proto-field"><label htmlFor="vendor-name">Vendor name</label><input id="vendor-name" className="proto-input" value={vendorName} disabled={savingVendor} onChange={(event) => updateVendorDraft({ name: event.target.value, contact: vendorContact, specialty: vendorSpecialty })} placeholder="e.g. Bangkok Construction Co." /></div><div className="proto-field"><label htmlFor="vendor-contact">Contact info</label><input id="vendor-contact" className="proto-input" value={vendorContact} disabled={savingVendor} onChange={(event) => updateVendorDraft({ name: vendorName, contact: event.target.value, specialty: vendorSpecialty })} placeholder="email or phone" /></div><div className="proto-field"><label htmlFor="vendor-specialty">Specialty</label><select id="vendor-specialty" className="proto-select" value={vendorSpecialty} disabled={savingVendor} onChange={(event) => updateVendorDraft({ name: vendorName, contact: vendorContact, specialty: event.target.value })}>{SPECIALTIES.map((specialty) => <option key={specialty}>{specialty}</option>)}</select></div>{editingVendor && <p className="settings-warning">Renaming this vendor updates <strong>{editingVendor.linkedBoqCount}</strong> linked BOQs.</p>}</div><DialogFooter><button className="btn btn-secondary" onClick={closeVendorDialog} disabled={savingVendor}>Cancel</button><button className="btn btn-primary" onClick={() => void handleSaveVendor()} disabled={savingVendor}>{savingVendor && <Loader2 className="proto-spinner" aria-hidden="true" />}{savingVendor ? "Saving…" : editingVendor ? "Save changes" : "Add vendor"}</button></DialogFooter></DialogContent></Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}><AlertDialogContent showCloseButton={false}><AlertDialogHeader><AlertDialogTitle>Delete unit “{deleteTarget?.unit}”?</AlertDialogTitle><AlertDialogDescription>{deleteTarget?.usageCount === null ? "This removes the unit from the workspace picker. BOQ items keep their value until reassigned." : `Cannot delete: ${deleteTarget?.usageCount} item${deleteTarget?.usageCount === 1 ? "" : "s"} use this unit. Reassign them first.`}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter>{deleteTarget?.usageCount === null && <button className="btn btn-danger btn-sm" onClick={() => void handleConfirmDelete()} disabled={unitBusy !== null}>Delete</button>}<button className="btn btn-secondary btn-sm" onClick={() => setDeleteTarget(null)}>Close</button></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  )
}
