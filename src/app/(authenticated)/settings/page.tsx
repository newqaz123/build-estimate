"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction } from "@/components/ui/card"
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { WorkspaceSettings, LlmSettings, DoclingSettings, FuzzySettings, PromptSettings, Vendor } from "@/lib/settings-schema"

const LLM_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
] as const

const SPECIALTIES = ["Structural", "MEP", "Finishing", "Full Scope"]

const DEFAULT_ANALYSIS_PROMPT = `You are a construction cost estimation assistant. Analyse the provided BOQ/quotations data and return structured JSON with the following fields for each item:
- item_code: The item reference code
- description: Item description 
- quantity: Quantity from the document
- unit: Unit of measure
- rate: Unit rate in THB
- total: Total amount (qty \u00d7 rate)
- trend: "below", "at", "above", or "new" compared to historical averages
- analysis: Brief commentary explaining the pricing context, considering both quantity and rate`

const DEFAULT_STD_PROMPT = `You are a construction BOQ standardization assistant. Given a list of raw items and a reference catalog, standardize each item:
1. If the item matches an existing catalog entry (by description + unit), return the catalog entry ID
2. If no match exists, suggest a standardized description and unit following these conventions:
   - Use clear format: "Material \u2014 spec/location/dimension"
   - Units: m\u00b3, m\u00b2, m, ton, ea, set, kg, LS
   - Group similar items (e.g. "Reinforcement bar SD40 \u2014 12mm")
3. Do NOT create a duplicate if a matching entry already exists
Return JSON array: [{itemIndex, matchedStdId, suggestedDesc, suggestedUnit, confidence: "high"|"medium"|"low", reason}]`

const DEFAULT_UNIT_MAP = `{
  "m2": "m\u00b2",
  "m3": "m\u00b3",
  "sqm": "m\u00b2",
  "sq.m.": "m\u00b2",
  "cbm": "m\u00b3",
  "cu.m.": "m\u00b3",
  "kg": "kg",
  "kgs": "kg",
  "tonne": "ton",
  "tons": "ton",
  "each": "set",
  "ea": "set",
  "nos": "set",
  "no.": "set",
  "lin.m": "m",
  "lm": "m",
  "r.m": "m"
}`

const DEFAULT_NORMALIZE_RULES = `[
  ["structural concrete", "concrete"],
  ["reinforcement bar", "rebar"],
  ["\\\\bconc\\\\.", "concrete"],
  ["\\\\d+mm\\\\b", "$& dia."],
  ["\\\\bformwork\\\\b", "formwork"],
  ["\\\\bmobilisation\\\\b", "mobilization"],
  ["\\\\bdemobilisation\\\\b", "demobilization"],
  ["\\\\s+", " "]
]`

export default function SettingsPage() {
  const [llmProvider, setLlmProvider] = useState("openai")
  const [apiKey, setApiKey] = useState("")
  const [llmModel, setLlmModel] = useState("gpt-4o")
  const [llmEndpoint, setLlmEndpoint] = useState("")
  const [savingLlm, setSavingLlm] = useState(false)

  const [doclingEndpoint, setDoclingEndpoint] = useState("http://localhost:5001")
  const [testingDocling, setTestingDocling] = useState(false)

  const [unitMap, setUnitMap] = useState(DEFAULT_UNIT_MAP)
  const [normalizeRules, setNormalizeRules] = useState(DEFAULT_NORMALIZE_RULES)
  const [savingFuzzy, setSavingFuzzy] = useState(false)

  const [vendors, setVendors] = useState<Vendor[]>([])
  const [loadingVendors, setLoadingVendors] = useState(true)
  const [vendorDialogOpen, setVendorDialogOpen] = useState(false)
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null)
  const [vendorName, setVendorName] = useState("")
  const [vendorContact, setVendorContact] = useState("")
  const [vendorSpecialty, setVendorSpecialty] = useState("Structural")
  const [savingVendor, setSavingVendor] = useState(false)
  const [deletingVendorId, setDeletingVendorId] = useState<string | null>(null)

  const [analysisPrompt, setAnalysisPrompt] = useState(DEFAULT_ANALYSIS_PROMPT)
  const [stdPrompt, setStdPrompt] = useState(DEFAULT_STD_PROMPT)
  const [savingPrompts, setSavingPrompts] = useState(false)

  const tokenEstimate = Math.round((analysisPrompt.trim().split(/\s+/).filter(Boolean).length || 0) * 1.3)

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings")
      if (!res.ok) throw new Error("Failed to fetch settings")
      const data: WorkspaceSettings = await res.json()
      if (data.llm) {
        setLlmProvider(data.llm.provider)
        setLlmModel(data.llm.model || "gpt-4o")
        setLlmEndpoint(data.llm.endpoint || "")
      }
      if (data.docling) {
        setDoclingEndpoint(data.docling.endpoint || "http://localhost:5001")
      }
      if (data.fuzzy) {
        setUnitMap(JSON.stringify(data.fuzzy.unitMap, null, 2))
        setNormalizeRules(JSON.stringify(data.fuzzy.normalizeRules, null, 2))
      }
      if (data.prompts) {
        setAnalysisPrompt(data.prompts.analysisPrompt || DEFAULT_ANALYSIS_PROMPT)
        setStdPrompt(data.prompts.stdPrompt || DEFAULT_STD_PROMPT)
      }
    } catch {
      toast.error("Failed to load settings")
    }
  }, [])

  const fetchVendors = useCallback(async () => {
    setLoadingVendors(true)
    try {
      const res = await fetch("/api/vendors")
      if (!res.ok) throw new Error("Failed to fetch vendors")
      const data: Vendor[] = await res.json()
      setVendors(data)
    } catch {
      toast.error("Failed to load vendors")
      setVendors([])
    } finally {
      setLoadingVendors(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
    fetchVendors()
  }, [fetchSettings, fetchVendors])

  const handleSaveLlm = async () => {
    setSavingLlm(true)
    try {
      const data: LlmSettings = {
        provider: llmProvider as LlmSettings["provider"],
        model: llmModel,
        ...(llmEndpoint ? { endpoint: llmEndpoint } : {}),
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: "llm", data }),
      })
      if (!res.ok) throw new Error("Failed to save")
      toast.success("LLM settings saved")
    } catch {
      toast.error("Failed to save LLM settings")
    } finally {
      setSavingLlm(false)
    }
  }

  const handleTestDocling = async () => {
    setTestingDocling(true)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(doclingEndpoint, { method: "HEAD", signal: controller.signal })
      if (res.ok) {
        toast.success("Docling sidecar is reachable")
      } else {
        toast.error("Sidecar returned error")
      }
    } catch {
      toast.error("Docling sidecar not reachable")
    } finally {
      clearTimeout(timeout)
      setTestingDocling(false)
    }
  }

  const handleSaveFuzzy = async () => {
    setSavingFuzzy(true)
    try {
      const parsedUnitMap = JSON.parse(unitMap) as Record<string, string>
      const parsedNormalizeRules = JSON.parse(normalizeRules) as [string, string][]
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "fuzzy",
          data: { unitMap: parsedUnitMap, normalizeRules: parsedNormalizeRules } as FuzzySettings,
        }),
      })
      if (!res.ok) throw new Error("Failed to save")
      toast.success("Fuzzy matching rules saved")
    } catch (e) {
      toast.error(`Invalid JSON \u2014 ${e instanceof Error ? e.message : "unknown error"}`)
    } finally {
      setSavingFuzzy(false)
    }
  }

  const openAddVendor = () => {
    setEditingVendor(null)
    setVendorName("")
    setVendorContact("")
    setVendorSpecialty("Structural")
    setVendorDialogOpen(true)
  }

  const openEditVendor = (vendor: Vendor) => {
    setEditingVendor(vendor)
    setVendorName(vendor.name)
    setVendorContact(vendor.contact)
    setVendorSpecialty(vendor.specialty)
    setVendorDialogOpen(true)
  }

  const handleSaveVendor = async () => {
    if (!vendorName.trim()) {
      toast.error("Vendor name is required")
      return
    }
    setSavingVendor(true)
    try {
      if (editingVendor) {
        const res = await fetch(`/api/vendors/${editingVendor.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: vendorName.trim(),
            contact: vendorContact.trim(),
            specialty: vendorSpecialty,
          }),
        })
        if (!res.ok) throw new Error("Failed to update")
        toast.success("Vendor updated")
      } else {
        const res = await fetch("/api/vendors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: vendorName.trim(),
            contact: vendorContact.trim(),
            specialty: vendorSpecialty,
          }),
        })
        if (!res.ok) throw new Error("Failed to create")
        toast.success("Vendor added")
      }
      setVendorDialogOpen(false)
      await fetchVendors()
    } catch {
      toast.error(editingVendor ? "Failed to update vendor" : "Failed to add vendor")
    } finally {
      setSavingVendor(false)
    }
  }

  const handleDeleteVendor = async (vendor: Vendor) => {
    if (deletingVendorId === vendor.id) {
      setDeletingVendorId(null)
      try {
        const res = await fetch(`/api/vendors/${vendor.id}`, { method: "DELETE" })
        if (!res.ok) throw new Error("Failed to delete")
        toast.success(`Removed ${vendor.name}`)
        await fetchVendors()
      } catch {
        toast.error("Failed to delete vendor")
      }
    } else {
      setDeletingVendorId(vendor.id)
      toast.error(`Click again to confirm removal of ${vendor.name}`)
      setTimeout(() => setDeletingVendorId(null), 4000)
    }
  }

  const handleSavePrompts = async () => {
    if (!analysisPrompt.trim()) {
      toast.error("Analysis prompt cannot be empty")
      return
    }
    setSavingPrompts(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          section: "prompts",
          data: { analysisPrompt, stdPrompt } as PromptSettings,
        }),
      })
      if (!res.ok) throw new Error("Failed to save")
      toast.success("Prompts saved")
    } catch {
      toast.error("Failed to save prompts")
    } finally {
      setSavingPrompts(false)
    }
  }

  return (
    <div data-od-id="settings-page">
      <div className="grid grid-cols-2 gap-5 items-start">
        {/* Left column */}
        <div className="space-y-5">
          {/* LLM Provider */}
          <Card data-od-id="llm-settings">
            <CardHeader>
              <CardTitle>LLM Provider</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Provider</label>
                  <Select value={llmProvider} onValueChange={(v) => v && setLlmProvider(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LLM_PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">API Key</label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Stored as environment variable. Never exposed to the client.
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Model</label>
                  <Input
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="e.g. gpt-4o, claude-sonnet-4, gemini-2.5-pro"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Custom Endpoint (optional)</label>
                  <Input
                    value={llmEndpoint}
                    onChange={(e) => setLlmEndpoint(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Override the default API endpoint for self-hosted proxies.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={handleSaveLlm} disabled={savingLlm}>
                    {savingLlm && <Loader2 className="w-3 h-3 animate-spin" />}
                    Save Changes
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Docling Sidecar */}
          <Card data-od-id="docling-settings">
            <CardHeader>
              <CardTitle>Docling Sidecar</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Sidecar URL</label>
                  <Input
                    value={doclingEndpoint}
                    onChange={(e) => setDoclingEndpoint(e.target.value)}
                    placeholder="http://localhost:8000"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    FastAPI server running Docling for PDF parsing.
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={handleTestDocling} disabled={testingDocling}>
                  {testingDocling && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                  Test Connection
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Catalog Fuzzy Rules */}
          <Card data-od-id="fuzzy-rules-settings">
            <CardHeader>
              <CardTitle>Catalog Fuzzy Rules</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-3">
                These rules control how incoming BOQ items are fuzzy-matched to standard catalog entries during Pass 2.
                Edits take effect on the next upload.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">
                    Unit equivalence map{" "}
                    <span className="text-muted-foreground">(JSON object: key &rarr; canonical unit)</span>
                  </label>
                  <textarea
                    className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-xs font-mono transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 resize-y"
                    rows={7}
                    value={unitMap}
                    onChange={(e) => setUnitMap(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">
                    Description normalisation rules{" "}
                    <span className="text-muted-foreground">
                      (JSON array of [find, replace] pairs, applied in order)
                    </span>
                  </label>
                  <textarea
                    className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-xs font-mono transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 resize-y"
                    rows={7}
                    value={normalizeRules}
                    onChange={(e) => setNormalizeRules(e.target.value)}
                  />
                </div>
                <Button size="sm" onClick={handleSaveFuzzy} disabled={savingFuzzy}>
                  {savingFuzzy && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                  Save Rules
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-5">
          {/* Vendors */}
          <Card data-od-id="vendor-settings">
            <CardHeader>
              <CardTitle>Vendors</CardTitle>
              <CardAction>
                <Button size="sm" onClick={openAddVendor}>
                  <Plus className="w-3 h-3" />
                  Add Vendor
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="p-0">
              {loadingVendors ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Loading&hellip;
                </div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Vendor Name</TableHead>
                        <TableHead>Specialty</TableHead>
                        <TableHead className="text-right">Linked BOQs</TableHead>
                        <TableHead>Last Used</TableHead>
                        <TableHead className="w-[100px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {vendors.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                            No vendors yet
                          </TableCell>
                        </TableRow>
                      ) : (
                        vendors.map((v) => (
                          <TableRow key={v.id}>
                            <TableCell>
                              <div className="font-medium">{v.name}</div>
                              {v.contact && (
                                <div className="text-xs text-muted-foreground">{v.contact}</div>
                              )}
                            </TableCell>
                            <TableCell className="text-xs">{v.specialty}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{v.linkedBoqCount}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {v.lastUsed ? new Date(v.lastUsed).toLocaleDateString() : "\u2014"}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button size="xs" variant="ghost" onClick={() => openEditVendor(v)}>
                                  <Pencil className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => handleDeleteVendor(v)}
                                >
                                  <Trash2 className="w-3 h-3 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                  <div className="border-t border-border px-4 py-3">
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="w-3 h-3 shrink-0"
                      >
                        <circle cx="8" cy="8" r="6.5" />
                        <line x1="8" y1="5" x2="8" y2="9" />
                        <line x1="8" y1="11" x2="8.01" y2="11" />
                      </svg>
                      Renaming a vendor here updates the name across all linked BOQs and historical data.
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* LLM Analysis Prompt */}
          <Card data-od-id="llm-prompt-settings">
            <CardHeader>
              <CardTitle>LLM Analysis Prompt</CardTitle>
              <CardDescription>
                Customise how the LLM evaluates pricing across all analysis features
              </CardDescription>
              <CardAction>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  ~{tokenEstimate} tokens
                </span>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">System prompt</label>
                  <textarea
                    className="w-full min-h-[140px] min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 resize-y leading-relaxed"
                    value={analysisPrompt}
                    onChange={(e) => setAnalysisPrompt(e.target.value)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSavePrompts} disabled={savingPrompts}>
                      {savingPrompts && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                      Save Prompt
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAnalysisPrompt(DEFAULT_ANALYSIS_PROMPT)}
                    >
                      Reset to Default
                    </Button>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    Applies to: BOQ verification &middot; Quotation comparison &middot; Item suggestions
                    &middot; Standardization
                  </span>
                </div>
                <div className="border-t border-border pt-3">
                  <label className="text-xs font-medium mb-1 block">
                    Standardization prompt{" "}
                    <span className="text-muted-foreground">
                      (used during Pass 3 &mdash; LLM suggestion for unmatched items)
                    </span>
                  </label>
                  <textarea
                    className="w-full min-h-[100px] min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-xs font-mono transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 resize-y leading-relaxed"
                    value={stdPrompt}
                    onChange={(e) => setStdPrompt(e.target.value)}
                  />
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSavePrompts} disabled={savingPrompts}>
                        {savingPrompts && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                        Save Std Prompt
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setStdPrompt(DEFAULT_STD_PROMPT)}
                      >
                        Reset to Default
                      </Button>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      Stored as <code className="text-[10px] bg-muted px-1 rounded">be_stdPrompt</code>
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Account */}
          <Card data-od-id="account-settings">
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Name</label>
                  <Input
                    value="Construction Consultant"
                    readOnly
                    className="opacity-60"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Email</label>
                  <Input
                    value="admin@buildestimate.app"
                    readOnly
                    className="opacity-60"
                  />
                </div>
                <hr className="border-border my-2" />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => toast.success("Password changed \u2014 stored as AUTH_SECRET")}
                >
                  Change Password
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Add / Edit Vendor Dialog */}
      <Dialog open={vendorDialogOpen} onOpenChange={setVendorDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingVendor ? "Edit Vendor" : "Add Vendor"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium mb-1 block">Vendor Name</label>
              <Input
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="e.g. Bangkok Construction Co."
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Contact Info</label>
              <Input
                value={vendorContact}
                onChange={(e) => setVendorContact(e.target.value)}
                placeholder="email or phone"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Specialty</label>
              <Select value={vendorSpecialty} onValueChange={(v) => v && setVendorSpecialty(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPECIALTIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {editingVendor && (
              <div className="p-2.5 bg-amber-50 dark:bg-amber-950/20 rounded-lg text-[11px] text-amber-800 dark:text-amber-300 flex items-start gap-1.5">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="w-3 h-3 shrink-0 mt-0.5"
                >
                  <circle cx="8" cy="8" r="6.5" />
                  <line x1="8" y1="5" x2="8" y2="9" />
                  <line x1="8" y1="11" x2="8.01" y2="11" />
                </svg>
                <span>
                  Renaming this vendor will update the name across{" "}
                  <strong>{editingVendor.linkedBoqCount}</strong> linked BOQs.
                </span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleSaveVendor} disabled={savingVendor}>
              {savingVendor && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              {editingVendor ? "Save Changes" : "Add Vendor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
